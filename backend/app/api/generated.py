"""Generated playlists: saved searches (fuzzy text + metadata + AI-classifier
filters) over one source playlist.

A generated playlist is just a saved search; re-resolving it (see _resolve) is
a pure DB read - no Spotify calls, so it never costs quota. It can be exported
for the user to import into Spotify through a third-party transfer
(TuneMyMusic, Soundiiz) - see GET /generated/{gid}/export.
"""
from __future__ import annotations
import csv
import io
import json
import re
from datetime import datetime
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import func
from ..db import SessionLocal
from ..models import Playlist, Track, GeneratedPlaylist
from .search import classifications_map

router = APIRouter()


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



# ---------------------------------------------------------------------------
# Export: a generated playlist -> a file the user imports into Spotify
# ---------------------------------------------------------------------------

_EXPORT_FORMATS = ("csv", "m3u8", "txt")
_EXPORT_MEDIA = {"csv": "text/csv", "m3u8": "audio/x-mpegurl", "txt": "text/plain"}
_EXPORT_EXT = {"csv": "csv", "m3u8": "m3u8", "txt": "txt"}


def _slugify(name: str) -> str:
    """Lowercase; run every non-alphanumeric sequence to a single hyphen."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _track_artists(t):
    """artists is JSON text of [{id,name,uri}]; join the names, guard empty."""
    try:
        arr = json.loads(t.artists or "[]")
    except (ValueError, TypeError):
        return ""
    names = [a.get("name", "") for a in arr if isinstance(a, dict) and a.get("name")]
    return ", ".join(names)


def _to_seconds(duration_ms):
    return round(int(duration_ms or 0) / 1000)


def _mss(duration_ms) -> str:
    """Integer seconds -> "m:ss" (225000 ms -> "3:45")."""
    secs = _to_seconds(duration_ms)
    return f"{secs // 60}:{secs % 60:02d}"


def _trackline(artist: str, title: str) -> str:
    return f"{artist} - {title}" if artist else title


def _build_csv(tracks):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["title", "artist", "album", "duration", "isrc", "spotify_url"])
    for t in tracks:
        artist = _track_artists(t)
        w.writerow([t.name or "", artist, t.album_name or "", _mss(t.duration_ms),
                    t.isrc or "", t.external_url or ""])
    return buf.getvalue()


def _build_m3u8(tracks):
    lines = ["#EXTM3U"]
    for t in tracks:
        lines.append(f"#EXTINF:{_to_seconds(t.duration_ms)},{_trackline(_track_artists(t), t.name or '')}")
        lines.append(t.external_url or "")
    return "\n".join(lines) + "\n"


def _build_txt(tracks):
    return "\n".join(_trackline(_track_artists(t), t.name or "") for t in tracks)


def _build_export(fmt: str, tracks):
    if fmt == "csv":
        return _build_csv(tracks)
    if fmt == "m3u8":
        return _build_m3u8(tracks)
    return _build_txt(tracks)


@router.get("/generated/{gid}/export")
def export_generated(gid: int, format: str = "csv"):
    """Download a generated playlist's resolved tracks as a file the user can
    import into Spotify (TuneMyMusic / Soundiiz). Pure DB read - no Spotify API
    calls. format is one of csv (default), m3u8, txt."""
    fmt = (format or "").strip().lower()
    if fmt not in _EXPORT_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported format '{format}' (choose from: csv, m3u8, txt)",
        )
    db = SessionLocal()
    try:
        gp = db.get(GeneratedPlaylist, gid)
        if gp is None:
            raise HTTPException(status_code=404, detail="generated playlist not found")
        tracks = _resolve(db, gp)
        slug = _slugify(gp.name) or "playlist"
        return Response(
            content=_build_export(fmt, tracks),
            media_type=_EXPORT_MEDIA[fmt],
            headers={"Content-Disposition": f'attachment; filename="{slug}.{_EXPORT_EXT[fmt]}"'},
        )
    finally:
        db.close()

