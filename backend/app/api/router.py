from __future__ import annotations
import json
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from sqlalchemy import func
from ..db import get_db, SessionLocal
from ..models import User, Playlist, Track, ClassificationRun
from ..config import get_settings
from ..spotify.auth import authorize_redirect_url, authenticate_code
from ..spotify.download import download_playlist
from ..spotify.client import SpotifyAPI
from ..spotify import credentials
from pydantic import BaseModel
from ..inference.runner import run_classification
from ..inference.adapter import JSON_SCHEMA as LLM_SCHEMA
from .schemas import *
from .search import query_tracks, build_playlist_from_query

api_router = APIRouter()
settings = get_settings()


def current_spotify():
    db = SessionLocal()
    try:
        u = db.query(User).first()
        if not u:
            raise RuntimeError("not authenticated")
        return SpotifyAPI(u.access_token, refresh=u.refresh_token, expires_at=u.token_expires_at)
    finally:
        db.close()


@api_router.get("/oauth/authorize")
def oauth_authorize(state: str | None = None):
    if not credentials.configured():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "not_configured",
                "message": "Spotify credentials are not configured on the server.",
            },
        )
    url, st = authorize_redirect_url(state)
    return {"authorize_url": url, "state": st}


@api_router.get("/oauth/redirect")
def oauth_redirect(code: str, state: str | None = None):
    try:
        authenticate_code(code)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"status": "ok", "message": "authenticated"}


@api_router.get("/auth/status")
def auth_status():
    db = SessionLocal()
    try:
        u = db.query(User).first()
        if not u:
            return {"authenticated": False, "configured": credentials.configured()}
        return {"authenticated": True, "display_name": u.display_name,
                "spotify_id": u.spotify_id, "configured": credentials.configured()}
    finally:
        db.close()


class SpotifyCredentialsIn(BaseModel):
    client_id: str
    client_secret: str


@api_router.post("/spotify/credentials")
def set_spotify_credentials(body: SpotifyCredentialsIn):
    """Persist the Spotify client credentials to the bind-mounted credentials file."""
    path = credentials.save_credentials(body.client_id.strip(), body.client_secret.strip())
    return {"status": "ok", "path": path, "configured": credentials.configured()}


@api_router.get("/spotify/credentials")
def get_spotify_credentials():
    """Report whether credentials are set (never returns the secret)."""
    c = credentials.load_credentials()
    return {"configured": credentials.configured(), "client_id": c["client_id"]}


@api_router.get("/playlists")
def get_playlists(limit: int = Query(50)):
    db = SessionLocal()
    try:
        rows = db.query(Playlist).limit(limit).all()
        counts = db.query(Track.playlist_id, func.count(Track.id)).group_by(Track.playlist_id).all()
        cnt = {pid: n for pid, n in counts}
        return [{"id": p.id, "spotify_playlist_id": p.spotify_playlist_id, "name": p.name,
                 "description": p.description, "owner_id": p.owner_id, "is_public": p.is_public,
                 "external_url": p.external_url, "fetched_at": p.fetched_at,
                 "track_count": cnt.get(p.id, 0)} for p in rows]
    finally:
        db.close()


@api_router.post("/playlists/{pl_id}/download")
def download(pl_id: int):
    try:
        api = current_spotify()
        n = download_playlist(api, pl_id)
        return {"status": "ok", "downloaded": n}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.post("/playlists/{pl_id}/classify")
def classify(pl_id: int, name: str = Body("...", embed=True), use_semantic: bool = True):
    try:
        run = run_classification(pl_id, name, use_semantic=use_semantic)
        return run_to_out(run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.get("/playlists/{pl_id}/tracks")
def list_tracks(pl_id: int):
    db = SessionLocal()
    try:
        rows = db.query(Track).filter_by(playlist_id=pl_id).order_by(Track.playlist_track_index).all()
        return [track_to_out(r) for r in rows]
    finally:
        db.close()


@api_router.post("/search")
def search(q: SearchQuery):
    tracks = build_playlist_from_query(q)
    return {"count": len(tracks), "tracks": tracks}


@api_router.post("/generate", response_model=GeneratePlaylistOut)
def generate(body: GeneratePlaylistIn):
    tracks = build_playlist_from_query(body.search)
    result = {"matched_count": len(tracks)}
    if body.push_to_spotify:
        try:
            api = current_spotify()
            new_id = create_spotify_playlist(api, body.name, body.description, tracks)
            result["spotify_playlist_id"] = new_id
            result["spotify_external_url"] = f"https://open.spotify.com/playlist/{new_id}"
        except Exception as e:
            result["push_error"] = str(e)
    else:
        result["export_path"] = write_json(tracks)
    return result


@api_router.get("/runs")
def get_runs():
    db = SessionLocal()
    try:
        rows = db.query(ClassificationRun).order_by(ClassificationRun.created_at.desc()).all()
        return [run_to_out(r) for r in rows]
    finally:
        db.close()


def track_to_out(t):
    return TrackOut.model_validate(t)

def run_to_out(r):
    return ClassificationRunOut.model_validate(r)


def create_spotify_playlist(api, name, description, tracks):
    me = api.get("/me")
    scope_ok = any(s in me.get("scopes", []) for s in ("playlist-modify-public", "playlist-modify-private"))
    if not scope_ok:
        raise RuntimeError("Missing playlist-modify scope; re-authenticate and grant push-back scope.")
    payload = {"name": name, "description": description or f"{name} (generated by Spotify Tracker)"}
    new_pl = api.post(f"/users/{me['id']}/playlists", json=payload)
    new_id = new_pl["id"]
    uris = [t["uri"] for t in tracks if t.get("uri")][:100]
    for i in range(0, len(uris), 100):
        chunk = uris[i:i + 100]
        api.post(f"/playlists/{new_id}/tracks", json={"uris": chunk})
    return new_id


def write_json(tracks):
    import os, tempfile
    os.makedirs("/tmp/spotify-tracker", exist_ok=True)
    path = f"/tmp/spotify-tracker/playlist_{len(tracks)}_tracks.json"
    with open(path, "w") as f:
        json.dump(tracks, f, indent=2)
    return path