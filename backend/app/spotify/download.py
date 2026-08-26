import json
from datetime import datetime, timezone
from ..db import SessionLocal
from ..models import User, Playlist, Track
from .auth import save_user_from_token
from .client import SpotifyAPI


def get_or_create_api():
    db = SessionLocal()
    try:
        user = db.query(User).first()
        if not user:
            return None
        return SpotifyAPI(user.access_token, refresh=user.refresh_token, expires_at=user.token_expires_at)
    finally:
        db.close()


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


def _batch_audio_features(api: SpotifyAPI, ids):
    results = {}
    for i in range(0, len(ids), 50):
        chunk = ids[i:i + 50]
        try:
            data = api.get("/audio-features", params={"ids": ",".join(chunk)})
        except Exception as e:
            # Audio Features can be unavailable (403) for new/personal apps under
            # Spotify's extended-quota changes. Degrade to metadata-only rather than
            # failing the entire download.
            if "403" in str(e):
                break
            continue
        for feat in data.get("audio_features", []) or []:
            if feat and feat.get("id"):
                results[feat["id"]] = feat
    return results


def download_playlist(api: SpotifyAPI, playlist_db_id: int) -> int:
    """Fetch a playlist's tracks and upsert into the DB.

    Commits after every page so progress survives Spotify quota interruptions
    (429 QUOTA_EXCEEDED). A re-run resumes from the number of tracks already saved
    for this playlist instead of re-fetching from the start, so a large playlist
    can grind across daily quota windows.
    """
    db = SessionLocal()
    try:
        pl = db.get(Playlist, playlist_db_id)
        if pl is None:
            raise RuntimeError(f"Local playlist {playlist_db_id} not found")
        url = f"/playlists/{pl.spotify_playlist_id}/items"
        # Resume: skip the pages already saved for this playlist.
        offset = db.query(Track).filter(Track.playlist_id == pl.id).count()
        total = offset
        while True:
            page = api.get(url, params={"limit": 100, "offset": offset})
            items = page.get("items", []) or []
            total = page.get("total", 0)
            for idx, entry in enumerate(items):
                t = entry.get("track")
                if not t or t.get("id") is None:
                    continue
                tid = t["id"]
                track = db.query(Track).filter_by(spotify_track_id=tid).first()
                if track is None:
                    track = Track(spotify_track_id=tid)
                    db.add(track)
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
            if offset >= total or not items:
                break
        # Best-effort audio features (403 in dev mode -> {}); metadata is already
        # saved, so a failure here must not lose the tracks.
        try:
            rows = db.query(Track).filter(Track.playlist_id == pl.id).all()
            feats = _batch_audio_features(api, [r.spotify_track_id for r in rows])
            for r in rows:
                feat = feats.get(r.spotify_track_id) or {}
                r.danceability = feat.get("danceability")
                r.energy = feat.get("energy")
                r.key = feat.get("key")
                r.mode = feat.get("mode")
                r.loudness = feat.get("loudness")
                r.tempo = feat.get("tempo")
                r.time_signature = feat.get("time_signature")
                r.acousticness = feat.get("acousticness")
                r.instrumentalness = feat.get("instrumentalness")
                r.liveness = feat.get("liveness")
                r.speechiness = feat.get("speechiness")
                r.valence = feat.get("valence")
            db.commit()
        except Exception:
            db.rollback()
        return total
    finally:
        db.close()
