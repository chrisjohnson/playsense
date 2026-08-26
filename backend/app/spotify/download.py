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
        data = api.get("/audio-features", params={"ids": ",".join(chunk)})
        for feat in data.get("audio_features", []) or []:
            if feat and feat.get("id"):
                results[feat["id"]] = feat
    return results


def download_playlist(api: SpotifyAPI, playlist_db_id: int) -> int:
    """Fetch a playlist's tracks + audio features and upsert into the DB."""
    db = SessionLocal()
    try:
        pl = db.get(Playlist, playlist_db_id)
        if pl is None:
            raise RuntimeError(f"Local playlist {playlist_db_id} not found")
        all_items = []
        url = f"/playlists/{pl.spotify_playlist_id}/tracks"
        params = {"limit": 100, "offset": 0}
        while True:
            page = api.get(url, params=params)
            for idx, entry in enumerate(page.get("items", []) or []):
                t = entry.get("track")
                if not t or t.get("id") is None:
                    continue
                t = dict(t)
                t["_index"] = idx
                all_items.append(t)
            total = page.get("total", 0)
            if len(all_items) >= total:
                break
            params["offset"] = len(all_items)
        ids = [t["id"] for t in all_items if t.get("id")]
        feats = _batch_audio_features(api, ids) if ids else {}
        for t in all_items:
            tid = t["id"]
            track = db.query(Track).filter_by(spotify_track_id=tid).first()
            artists = [{"id": a["id"], "name": a["name"], "uri": a.get("uri", "")} for a in t.get("artists", [])]
            album = t.get("album", {}) or {}
            feat = feats.get(tid) or {}
            if track is None:
                track = Track(spotify_track_id=tid)
                pl.tracks.append(track)
            track.name = t.get("name", "")
            track.artists = json.dumps(artists)
            track.album_name = album.get("name", "")
            track.album_id = album.get("id", "")
            track.release_date = str(album.get("release_date", "") or "")
            track.duration_ms = t.get("duration_ms")
            track.uri = t.get("uri", "")
            track.external_url = (t.get("external_urls") or {}).get("spotify", "")
            track.isrc = (t.get("external_ids") or {}).get("isrc", "") or ""
            track.playlist_track_index = t.get("_index", 0)
            track.danceability = feat.get("danceability")
            track.energy = feat.get("energy")
            track.key = feat.get("key")
            track.mode = feat.get("mode")
            track.loudness = feat.get("loudness")
            track.tempo = feat.get("tempo")
            track.time_signature = feat.get("time_signature")
            track.acousticness = feat.get("acousticness")
            track.instrumentalness = feat.get("instrumentalness")
            track.liveness = feat.get("liveness")
            track.speechiness = feat.get("speechiness")
            track.valence = feat.get("valence")
        pl.fetched_at = datetime.now(timezone.utc)
        db.commit()
        return len(all_items)
    finally:
        db.close()