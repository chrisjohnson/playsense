from __future__ import annotations
import json
from urllib.parse import quote
from fastapi import APIRouter, Depends, HTTPException, Query, Body
from fastapi.responses import RedirectResponse
from sqlalchemy import func
from ..db import get_db, SessionLocal
from ..models import User, Playlist, Track, ClassificationRun, Classifier, TrackClassification
from ..config import get_settings
from ..spotify.auth import authorize_redirect_url, authenticate_code
from ..spotify.download import current_spotify, sync_playlists
from ..spotify.client import SpotifyAPI
from ..spotify import credentials
from ..spotify.worker import enqueue as enqueue_download
from pydantic import BaseModel
from ..inference.runner import run_classification
from ..inference.adapter import JSON_SCHEMA as LLM_SCHEMA
from .schemas import *
from .search import run_search, classifications_map
from .classifiers import router as classifier_router  # noqa: F401
from .classifier_jobs import router as classifier_jobs_router  # noqa: F401
from .generated import router as generated_router  # noqa: F401

api_router = APIRouter()
api_router.include_router(classifier_router)
api_router.include_router(classifier_jobs_router)
api_router.include_router(generated_router)
settings = get_settings()


def _current_spotify_strict():
    api = current_spotify()
    if api is None:
        raise HTTPException(status_code=401, detail="Not authenticated. Connect to Spotify first.")
    return api


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
    base = settings.app_public_url.rstrip("/")
    try:
        authenticate_code(code)
    except Exception as e:
        # On failure, send the user back to the app with the error shown in the UI
        return RedirectResponse(url=base + "/?spotify_error=" + quote(str(e)), status_code=302)
    # Success: send the user back to the app (the SPA reloads and shows the connected state)
    return RedirectResponse(url=base + "/?spotify=connected", status_code=302)


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
                 "track_count": cnt.get(p.id, 0),
                  "is_default": bool(p.is_default),
                 "download_state": p.download_state or "idle",
                 "download_saved": p.download_saved or 0,
                 "download_total": p.download_total or 0,
                 "download_error": p.download_error or "",
                 "download_updated_at": p.download_updated_at} for p in rows]
    finally:
        db.close()


@api_router.post("/playlists/{pid}/default")
def set_default_playlist(pid: int):
    """Mark one playlist as the default (cleared on all others). Other pages
    open with the default playlist selected."""
    db = SessionLocal()
    try:
        pl = db.get(Playlist, pid)
        if pl is None:
            raise HTTPException(status_code=404, detail="Playlist not found")
        for p in db.query(Playlist).all():
            p.is_default = (p.id == pid)
        db.commit()
        return {"status": "ok", "default_playlist_id": pid}
    finally:
        db.close()


@api_router.post("/playlists/sync")
def sync_playlists_endpoint():
    api = _current_spotify_strict()
    try:
        pls = sync_playlists(api)
        return {"status": "ok", "count": len(pls), "playlists": [
            {"id": p.id, "spotify_playlist_id": p.spotify_playlist_id, "name": p.name,
             "description": p.description, "owner_id": p.owner_id, "is_public": p.is_public,
             "external_url": p.external_url, "fetched_at": p.fetched_at, "track_count": 0}
            for p in pls]}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.post("/playlists/{pl_id}/download")
def download(pl_id: int):
    """Enqueue the playlist for the background download worker.

    The worker grinds page by page across Spotify quota windows; progress is
    visible on GET /playlists (download_* fields) and survives restarts.
    """
    db = SessionLocal()
    try:
        pl = db.get(Playlist, pl_id)
        if pl is None:
            raise HTTPException(status_code=404, detail="playlist not found")
        if pl.download_state not in ("queued", "downloading", "waiting_quota"):
            pl.download_state = "queued"
            pl.download_error = ""
            db.commit()
            enqueue_download(pl.id)
        return {"status": "ok", "state": pl.download_state,
                "saved": pl.download_saved or 0, "total": pl.download_total or 0}
    finally:
        db.close()


@api_router.post("/playlists/{pl_id}/classify")
def classify(pl_id: int, name: str = Body("...", embed=True), use_semantic: bool = Body(True, embed=True)):
    # NOTE: use_semantic MUST stay a Body param - a bare `bool = True` would
    # become a query param and the body value would be silently ignored.
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
        cls_map = classifications_map(db, [t.id for t in rows])
        return [track_to_out(r, cls_map.get(r.id)) for r in rows]
    finally:
        db.close()


@api_router.post("/search")
def search(q: SearchQuery):
    return run_search(q)


@api_router.post("/generate", response_model=GeneratePlaylistOut)
def generate(body: GeneratePlaylistIn):
    tracks = run_search(body.search)["tracks"]
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


def track_to_out(t, classifications: dict | None = None):
    out = TrackOut.model_validate(t)
    out.classifications = classifications or {}
    return out

def run_to_out(r):
    return ClassificationRunOut.model_validate(r)


def create_spotify_playlist(api, name, description, tracks):
    me = api.get("/me")
    scope_ok = any(s in me.get("scopes", []) for s in ("playlist-modify-public", "playlist-modify-private"))
    if not scope_ok:
        raise RuntimeError("Missing playlist-modify scope; re-authenticate and grant push-back scope.")
    payload = {"name": name, "description": description or f"{name} (generated by playsense)"}
    new_pl = api.post(f"/users/{me['id']}/playlists", json=payload)
    new_id = new_pl["id"]
    uris = [t["uri"] for t in tracks if t.get("uri")][:100]
    for i in range(0, len(uris), 100):
        chunk = uris[i:i + 100]
        api.post(f"/playlists/{new_id}/tracks", json={"uris": chunk})
    return new_id


def write_json(tracks):
    import os, tempfile
    os.makedirs("/tmp/playsense", exist_ok=True)
    path = f"/tmp/playsense/playlist_{len(tracks)}_tracks.json"
    with open(path, "w") as f:
        json.dump(tracks, f, indent=2)
    return path