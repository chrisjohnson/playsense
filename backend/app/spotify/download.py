import json
import logging
from datetime import datetime, timezone

from ..db import SessionLocal
from ..models import User, Playlist, Track
from .client import SpotifyAPI

logger = logging.getLogger(__name__)

# Feb-2026 dev-mode API: playlist items moved to /playlists/{id}/tracks with a
# page limit capped at 50 (the old /items endpoint is deprecated, still accepts
# limit=100). In practice the NEW endpoint 403s for dev-mode apps, so this is
# really a fallback chain: try new first (future-proof), fall back to legacy.
_TRACKS_ENDPOINTS = [
    ("/playlists/{sid}/tracks", 50),
    ("/playlists/{sid}/items", 100),
]
_endpoint_cache: dict[str, tuple] = {}


def get_or_create_api():
    """Build a SpotifyAPI for the connected user, persisting rotated tokens."""
    db = SessionLocal()
    try:
        user = db.query(User).first()
        if not user:
            return None

        def saver(access_token, refresh_token, expires_at):
            # Persist rotated tokens in a fresh session (the outer one is open).
            sdb = SessionLocal()
            try:
                uu = sdb.get(User, user.id)
                if uu is not None:
                    uu.access_token = access_token
                    if refresh_token:
                        uu.refresh_token = refresh_token
                    uu.token_expires_at = expires_at
                    sdb.commit()
            finally:
                sdb.close()

        return SpotifyAPI(user.access_token, refresh=user.refresh_token,
                          expires_at=user.token_expires_at, token_saver=saver)
    finally:
        db.close()


# Kept name used by the router (identical behavior).
current_spotify = get_or_create_api


def list_playlists(api: SpotifyAPI, limit: int = 50):
    return api.get("/me/playlists", params={"limit": min(limit, 50)})["items"]


def ensure_playlist(api: SpotifyAPI, item: dict):
    db = SessionLocal()
    try:
        pl = db.query(Playlist).filter_by(spotify_playlist_id=item["id"]).first()
        if pl is None:
            user = db.query(User).first()
            if user is None:
                raise RuntimeError("Not authenticated")
            pl = Playlist(
                spotify_playlist_id=item["id"],
                name=item.get("name", ""),
                description=item.get("description", ""),
                images=json.dumps(item.get("images", [])),
                owner_id=(item.get("owner") or {}).get("id", ""),
                external_url=(item.get("external_urls") or {}).get("spotify", ""),
                is_public=item.get("public", False),
                user_id=user.id,
            )
            db.add(pl)
            db.commit()
            db.refresh(pl)
        return pl
    finally:
        db.close()


def sync_playlists(api: SpotifyAPI, max_playlists: int = 200) -> list:
    """Fetch the user's Spotify playlists (paginated, limit<=50) and upsert local rows."""
    from urllib.parse import urlparse, parse_qs
    pls = []
    params = {"limit": 50}
    url = "/me/playlists"
    while len(pls) < max_playlists:
        page = api.get(url, params=params)
        batch = page.get("items", []) or []
        if not batch:
            break
        for item in batch:
            pls.append(ensure_playlist(api, item))
        nxt = page.get("next")
        if not nxt:
            break
        params["offset"] = int(parse_qs(urlparse(nxt).query).get("offset", ["0"])[0])
    return pls


def _resolve_endpoint(api: SpotifyAPI, sid: str) -> tuple:
    """Pick a working playlist-items endpoint (new /tracks, legacy /items fallback).

    The probe costs one API request; the choice is cached per playlist.
    """
    if sid in _endpoint_cache:
        return _endpoint_cache[sid]
    last_err = None
    for path_tmpl, limit in _TRACKS_ENDPOINTS:
        try:
            api.get(path_tmpl.format(sid=sid), params={"limit": limit, "offset": 0})
            _endpoint_cache[sid] = (path_tmpl, limit)
            return path_tmpl, limit
        except RuntimeError as e:
            s = str(e)
            # 403/404/405/410 on the probe = endpoint unavailable for this
            # app/playlist combination in dev mode -> try the next candidate.
            if any(c in s for c in (" 403", " 404", " 405", " 410")):
                last_err = e
                continue
            raise
    raise RuntimeError(f"No working playlist-items endpoint for {sid}: {last_err}")


def _set_progress(db, pl: Playlist, state: str, saved: int | None = None,
                  total: int | None = None, error: str = ""):
    pl.download_state = state
    if saved is not None:
        pl.download_saved = saved
    if total is not None:
        pl.download_total = total
    pl.download_error = (error or "")[:1000]
    pl.download_updated_at = datetime.now(timezone.utc)
    db.commit()


def _saved_progress(db, pl: Playlist) -> tuple:
    """Return (rows_for_playlist, resume_offset).

    Resume offset is max(playlist_track_index)+1, which is correct even when
    the playlist contains duplicates (a duplicate reuses the same Track row
    and the count then undercounts the offset).
    """
    rows = db.query(Track).filter(Track.playlist_id == pl.id).all()
    if not rows:
        return 0, 0
    return len(rows), max(r.playlist_track_index for r in rows) + 1


def download_playlist(api: SpotifyAPI, playlist_db_id: int) -> dict:
    """One grind step: fetch as many pages as the quota allows, committing per page.

    Returns {"state": "done", "saved": n, "total": m} when complete.
    Raises SpotifyQuotaExceeded when the developer-account quota budget runs
    out mid-run (progress up to the last committed page is kept; the worker
    converts the raise into a waiting state + delayed retry).
    """
    db = SessionLocal()
    try:
        pl = db.get(Playlist, playlist_db_id)
        if pl is None:
            raise RuntimeError(f"Local playlist {playlist_db_id} not found")
        sid = pl.spotify_playlist_id
        path_tmpl, page_limit = _resolve_endpoint(api, sid)  # costs 1 request
        url = path_tmpl.format(sid=sid)
        saved, offset = _saved_progress(db, pl)
        total = pl.download_total or 0
        _set_progress(db, pl, "downloading", saved=saved, total=total)
        while True:
            page = api.get(url, params={"limit": page_limit, "offset": offset})
            items = page.get("items") or []
            total = page.get("total", 0) or total
            # In-page dedupe: a playlist can contain the same track twice. A row
            # added this page is not visible to db.query() until flush, so keep
            # the pending objects here to avoid UNIQUE constraint violations.
            page_seen: dict = {}
            for idx, entry in enumerate(items):
                # Feb-2026 dev-mode API renamed the entry's track object from
                # "track" to "item" (the old key now comes back null). Handle
                # both shapes.
                t = entry.get("track") or entry.get("item")
                if not t or t.get("id") is None:
                    continue
                if t.get("type") not in (None, "track"):
                    continue  # episodes etc. - not a track
                tid = t["id"]
                if tid in page_seen:
                    track = page_seen[tid]
                else:
                    track = db.query(Track).filter_by(spotify_track_id=tid).first()
                    if track is None:
                        track = Track(spotify_track_id=tid)
                        db.add(track)
                    page_seen[tid] = track
                artists = [{"id": a["id"], "name": a["name"], "uri": a.get("uri", "")} for a in t.get("artists", [])]
                album = t.get("album", {}) or {}
                track.name = t.get("name", "")
                track.artists = json.dumps(artists)
                track.album_name = album.get("name", "")
                track.album_id = album.get("id", "")
                track.release_date = str(album.get("release_date", "") or "")
                track.duration_ms = t.get("duration_ms")
                track.uri = t.get("uri", "")
                track.external_url = (t.get("external_urls") or {}).get("spotify", "")
                track.isrc = (t.get("external_ids") or {}).get("isrc", "") or ""
                track.playlist_id = pl.id
                track.playlist_track_index = offset + idx
            offset += len(items)
            pl.fetched_at = datetime.now(timezone.utc)
            db.commit()  # per-page commit: progress survives quota interruptions
            saved = db.query(Track).filter(Track.playlist_id == pl.id).count()
            if offset >= total or not items:
                _set_progress(db, pl, "done", saved=saved, total=total)
                logger.info("playlist %s complete: %s rows (%s total entries)", pl.id, saved, total)
                return {"state": "done", "saved": saved, "total": total}
            _set_progress(db, pl, "downloading", saved=saved, total=total)
        # SpotifyQuotaExceeded propagates from api.get: the last committed page
        # is kept and the worker schedules the next probe.
    finally:
        db.close()
