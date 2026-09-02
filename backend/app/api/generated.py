"""Generated playlists: saved searches (fuzzy text + metadata + AI-classifier
filters) over one source playlist, kept in sync with a Spotify playlist.

Quota design: a sync NEVER reads the Spotify playlist. The baseline of what
the playlist contains is last_synced_uris (what we last wrote); the diff is
desired vs baseline, so a sync costs only the add/remove write calls.
POST /generated/{id}/reread refreshes the baseline from the live playlist
(costs the page reads) - use it after editing the Spotify playlist by hand.
"""
from __future__ import annotations
import json
import re
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from ..db import SessionLocal
from ..models import Playlist, Track, GeneratedPlaylist
from ..spotify.download import get_or_create_api, _resolve_endpoint
from .search import classifications_map

router = APIRouter()

MAX_DIFF_LIST = 200  # per-side cap in the diff payload (counts are always exact)


# ---------------------------------------------------------------------------
# Client-parity fuzzy matching (ported from the Search page, Search.tsx)
# ---------------------------------------------------------------------------

def _lev1(a: str, b: str) -> bool:
    if a == b:
        return True
    x, y = (a, b) if len(a) <= len(b) else (b, a)
    if len(y) - len(x) > 1:
        return False
    i = 0
    while i < len(x) and x[i] == y[i]:
        i += 1
    if len(x) == len(y):
        for j in range(i + 1, len(x)):
            if x[j] != y[j]:
                return False
        return True
    for j in range(i, len(x)):
        if x[j] != y[j + 1]:
            return False
    return True


def _token_matches(tok: str, hay: str) -> bool:
    if tok in hay:
        return True
    if len(tok) < 4:
        return False
    for w in range(len(tok) - 1, len(tok) + 2):
        for i in range(0, len(hay) - w + 1):
            if _lev1(hay[i:i + w], tok):
                return True
    return False


def _fuzzy(query: str, hay: str) -> bool:
    toks = [t for t in re.split(r"\W+", query.lower(), flags=re.ASCII) if len(t) >= 2]
    if not toks:
        return True
    return all(_token_matches(t, hay) for t in toks)


# ---------------------------------------------------------------------------
# Resolution: run the saved search over the source playlist (no LLM)
# ---------------------------------------------------------------------------

def _resolve(db, gp: GeneratedPlaylist) -> list:
    spec = _spec_json(gp)
    scope = db.query(Track).filter(Track.playlist_id == gp.source_playlist_id)
    artist = (spec.get("artist") or "").strip()
    album = (spec.get("album") or "").strip()
    title = (spec.get("title") or "").strip()
    if artist:
        scope = scope.filter(Track.artists.ilike(f"%{artist}%"))
    if album:
        scope = scope.filter(Track.album_name.ilike(f"%{album}%"))
    if title:
        scope = scope.filter(Track.name.ilike(f"%{title}%"))
    if spec.get("min_year"):
        scope = scope.filter(func.substr(Track.release_date, 1, 4) >= str(spec["min_year"]))
    if spec.get("max_year"):
        scope = scope.filter(func.substr(Track.release_date, 1, 4) <= str(spec["max_year"]))
    if spec.get("min_dur_s"):
        scope = scope.filter(Track.duration_ms >= int(spec["min_dur_s"]) * 1000)
    if spec.get("max_dur_s"):
        scope = scope.filter(Track.duration_ms <= int(spec["max_dur_s"]) * 1000)
    if spec.get("language"):
        scope = scope.filter(Track.language == spec["language"])
    cands = scope.order_by(Track.playlist_track_index).all()

    q = (spec.get("q") or "").strip()
    cls_filters = spec.get("classifier_filters") or {}
    if not q and not cls_filters:
        return cands

    cmaps = classifications_map(db, [t.id for t in cands])
    out = []
    for t in cands:
        if q:
            artists = [a.get("name", "") for a in json.loads(t.artists or "[]")]
            hay = " ".join([t.name or "", " ".join(artists), t.album_name or ""]).lower()
            if not _fuzzy(q, hay):
                continue
        ok = True
        for cid_raw, want in cls_filters.items():
            v = (cmaps.get(t.id) or {}).get(str(cid_raw))
            if not v or v["stale"]:
                ok = False
                break
            val = v["value"]
            if isinstance(want, dict):
                # number/datetime range {min, max}
                num = _as_number(val)
                if num is None:
                    ok = False
                    break
                if want.get("min") not in (None, "") and num < float(want["min"]):
                    ok = False
                    break
                if want.get("max") not in (None, "") and num > float(want["max"]):
                    ok = False
                    break
            elif isinstance(want, bool) or isinstance(want, (int, float)):
                if val != want:
                    ok = False
                    break
            else:
                if str(val).lower().find(str(want).lower()) < 0:
                    ok = False
                    break
        if ok:
            out.append(t)
    return out


def _as_number(val) -> float | None:
    """JSON number, or ISO datetime -> epoch seconds (client parity: Date.parse)."""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    try:
        return float(datetime.fromisoformat(str(val)).timestamp())
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Sync / diff
# ---------------------------------------------------------------------------

def _spotify_contents(api, sid: str) -> set:
    """URIs currently in the Spotify playlist (full read - reread only)."""
    path_tmpl, page_limit = _resolve_endpoint(api, sid)
    uris: set = set()
    offset = 0
    while True:
        page = api.get(path_tmpl.format(sid=sid), params={"limit": page_limit, "offset": offset})
        items = page.get("items") or []
        for e in items:
            tr = e.get("track") or e.get("item") or {}
            uri = tr.get("uri") or ""
            if uri:
                uris.add(uri)
        offset += len(items)
        if not items or offset >= int(page.get("total", 0) or 0):
            break
    return uris


def sync_generated_row(db, gp: GeneratedPlaylist, dry_run: bool) -> dict:
    """Compute the desired-vs-baseline diff; when dry_run is False, apply it to
    Spotify. Caller commits. Raises on Spotify failure (row stays uncommitted).
    """
    desired = _resolve(db, gp)
    dmap: dict = {}
    for t in desired:
        if t.uri:
            dmap[t.uri] = t.name or ""
    if gp.spotify_playlist_id is None:
        added = list(dmap.keys())
        removed = []
    else:
        baseline = set(json.loads(gp.last_synced_uris or "[]"))
        added = [u for u in dmap if u not in baseline]
        removed = [u for u in baseline if u not in dmap]

    if dry_run:
        gp.last_sync_status = f"preview: +{len(added)} / -{len(removed)} (search matches {len(dmap)})"
        db.commit()  # status only
    else:
        api = get_or_create_api()
        if api is None:
            raise RuntimeError("Not connected to Spotify.")
        if gp.spotify_playlist_id is None:
            me = api.get("/me")
            payload = {"name": gp.name,
                       "description": gp.description or f"{gp.name} (generated by Spotify Tracker)"}
            new_pl = api.post(f"/users/{me['id']}/playlists", json=payload)
            gp.spotify_playlist_id = new_pl["id"]
            gp.spotify_external_url = new_pl.get("external_url", "")
        if added:
            for i in range(0, len(added), 100):
                api.post(f"/playlists/{gp.spotify_playlist_id}/tracks",
                         json={"uris": added[i:i + 100]})
        if removed:
            for i in range(0, len(removed), 100):
                api.raw("delete", f"/playlists/{gp.spotify_playlist_id}/tracks",
                        json={"tracks": [{"uri": u} for u in removed[i:i + 100]]})
        gp.last_synced_uris = json.dumps(list(dmap.keys()))
        gp.last_synced_at = datetime.now(timezone.utc)
        gp.last_sync_status = f"synced: +{len(added)} / -{len(removed)} (search matches {len(dmap)})"

    return {
        "dry_run": bool(dry_run),
        "will_create": gp.spotify_playlist_id is None,
        "total_desired": len(dmap),
        "added": len(added),
        "removed": len(removed),
        "added_tracks": [{"uri": u, "name": dmap[u]} for u in added[:MAX_DIFF_LIST]],
        "removed_tracks": [{"uri": u} for u in removed[:MAX_DIFF_LIST]],
        "preview_mode": bool(gp.preview_mode),
        "spotify_playlist_id": gp.spotify_playlist_id,
        "spotify_external_url": gp.spotify_external_url or "",
    }


def _spec_json(gp: GeneratedPlaylist) -> dict:
    try:
        return json.loads(gp.search_spec or "{}") or {}
    except json.JSONDecodeError:
        return {}


def _out(gp: GeneratedPlaylist, track_count: int | None = None) -> dict:
    return {
        "id": gp.id,
        "name": gp.name,
        "description": gp.description or "",
        "source_playlist_id": gp.source_playlist_id,
        "source_playlist_name": gp.source_playlist.name if gp.source_playlist else "",
        "search_spec": _spec_json(gp),
        "preview_mode": bool(gp.preview_mode),
        "sync_mode": gp.sync_mode or "once",
        "spotify_playlist_id": gp.spotify_playlist_id,
        "spotify_external_url": gp.spotify_external_url or "",
        "last_synced_at": gp.last_synced_at.isoformat() if gp.last_synced_at else None,
        "last_sync_status": gp.last_sync_status or "",
        "created_at": gp.created_at.isoformat() if gp.created_at else None,
        "track_count": track_count,
    }


class GeneratedIn(BaseModel):
    name: str
    description: str = ""
    source_playlist_id: int
    search_spec: dict = {}
    preview_mode: bool = True
    sync_mode: str = "once"


class GeneratedUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    search_spec: dict | None = None
    preview_mode: bool | None = None
    sync_mode: str | None = None


@router.get("/generated")
def list_generated():
    db = SessionLocal()
    try:
        gps = db.query(GeneratedPlaylist).order_by(GeneratedPlaylist.id).all()
        return [_out(gp, track_count=len(_resolve(db, gp))) for gp in gps]
    finally:
        db.close()


@router.post("/generated")
def create_generated(body: GeneratedIn):
    if body.sync_mode not in ("once", "ongoing"):
        raise HTTPException(status_code=422, detail="sync_mode must be 'once' or 'ongoing'")
    db = SessionLocal()
    try:
        if db.get(Playlist, body.source_playlist_id) is None:
            raise HTTPException(status_code=404, detail="source playlist not found")
        gp = GeneratedPlaylist(
            name=body.name.strip() or "Generated playlist",
            description=body.description or "",
            source_playlist_id=body.source_playlist_id,
            search_spec=json.dumps(body.search_spec or {}),
            preview_mode=bool(body.preview_mode),
            sync_mode=body.sync_mode,
        )
        db.add(gp)
        db.commit()
        db.refresh(gp)
        return _out(gp, track_count=len(_resolve(db, gp)))
    finally:
        db.close()


@router.put("/generated/{gid}")
def update_generated(gid: int, body: GeneratedUpdate):
    if body.sync_mode is not None and body.sync_mode not in ("once", "ongoing"):
        raise HTTPException(status_code=422, detail="sync_mode must be 'once' or 'ongoing'")
    db = SessionLocal()
    try:
        gp = db.get(GeneratedPlaylist, gid)
        if gp is None:
            raise HTTPException(status_code=404, detail="generated playlist not found")
        if body.name is not None:
            gp.name = body.name.strip() or gp.name
        if body.description is not None:
            gp.description = body.description
        if body.search_spec is not None:
            gp.search_spec = json.dumps(body.search_spec)
        if body.preview_mode is not None:
            gp.preview_mode = bool(body.preview_mode)
        if body.sync_mode is not None:
            gp.sync_mode = body.sync_mode
        db.commit()
        db.refresh(gp)
        return _out(gp, track_count=len(_resolve(db, gp)))
    finally:
        db.close()


@router.delete("/generated/{gid}")
def delete_generated(gid: int):
    db = SessionLocal()
    try:
        gp = db.get(GeneratedPlaylist, gid)
        if gp is None:
            raise HTTPException(status_code=404, detail="generated playlist not found")
        db.delete(gp)
        db.commit()
        return {"status": "ok"}
    finally:
        db.close()


class SyncIn(BaseModel):
    # Body model (a bare `dry_run: bool = False` would bind as a QUERY param
    # and the JSON body would be silently ignored - same trap as classify).
    dry_run: bool = False


@router.post("/generated/{gid}/sync")
def sync_generated(gid: int, body: SyncIn):
    db = SessionLocal()
    try:
        gp = db.get(GeneratedPlaylist, gid)
        if gp is None:
            raise HTTPException(status_code=404, detail="generated playlist not found")
        effective_dry = body.dry_run or bool(gp.preview_mode)  # preview mode always wins
        try:
            diff = sync_generated_row(db, gp, effective_dry)
        except HTTPException:
            raise
        except Exception as e:
            db.rollback()
            raise HTTPException(status_code=502, detail=str(e))
        diff["applied"] = not effective_dry
        return diff
    finally:
        db.close()


@router.post("/generated/{gid}/reread")
def reread_generated(gid: int):
    """Refresh the sync baseline from the LIVE Spotify playlist (full read -
    costs the page requests). Use after editing the playlist by hand."""
    db = SessionLocal()
    try:
        gp = db.get(GeneratedPlaylist, gid)
        if gp is None:
            raise HTTPException(status_code=404, detail="generated playlist not found")
        if not gp.spotify_playlist_id:
            raise HTTPException(status_code=400, detail="not synced yet - nothing to re-read")
        api = get_or_create_api()
        if api is None:
            raise HTTPException(status_code=401, detail="Not connected to Spotify.")
        try:
            uris = _spotify_contents(api, gp.spotify_playlist_id)
        except Exception as e:
            raise HTTPException(status_code=502, detail=str(e))
        gp.last_synced_uris = json.dumps(sorted(uris))
        gp.last_sync_status = f"re-read from Spotify: {len(uris)} tracks"
        db.commit()
        return {"status": "ok", "tracks_in_spotify": len(uris)}
    finally:
        db.close()
