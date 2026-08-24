import secrets
from urllib.parse import urlencode
from datetime import datetime, timedelta, timezone
import httpx
from ..config import get_settings


TOKEN_URL = "https://accounts.spotify.com/api/token"
AUTHORIZE_URL = "https://accounts.spotify.com/authorize"


def authorize_redirect_url(state: str | None = None) -> tuple[str, str]:
    settings = get_settings()
    if not state:
        state = secrets.token_urlsafe(16)
    params = {
        "response_type": "code",
        "client_id": settings.spotify_client_id,
        "scope": " ".join(settings.scopes_list),
        "redirect_uri": settings.spotify_redirect_uri,
        "state": state,
    }
    return AUTHORIZE_URL + "?" + urlencode(params), state


def _token_payload(extra: dict) -> dict:
    settings = get_settings()
    return {
        "grant_type": extra["grant_type"],
        "client_id": settings.spotify_client_id,
        "client_secret": settings.spotify_client_secret,
        **extra,
    }


def exchange_code(code: str, redirect_uri: str | None = None) -> dict:
    settings = get_settings()
    data = _token_payload({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri or settings.spotify_redirect_uri})
    with httpx.Client(timeout=settings.inference_timeout_seconds) as c:
        r = c.post(TOKEN_URL, data=data)
        r.raise_for_status()
        return r.json()


def refresh_access_token(refresh_token: str) -> dict:
    data = _token_payload({"grant_type": "refresh_token", "refresh_token": refresh_token})
    with httpx.Client(timeout=settings.inference_timeout_seconds) as c:
        r = c.post(TOKEN_URL, data=data)
        r.raise_for_status()
        return r.json()


def save_user_from_token(tok: dict, code: str | None = None, redirect_uri: str | None = None):
    from ..db import SessionLocal
    from ..models import User
    from .client import SpotifyAPI

    db = SessionLocal()
    try:
        user = db.query(User).first()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=tok.get("expires_in", 3600))
        if user is None:
            user = User(
                spotify_id=tok.get("spotify_id", ""),
                display_name=tok.get("displayName", ""),
                email=tok.get("email", ""),
                access_token=tok["access_token"],
                refresh_token=tok.get("refresh_token") or "",
                token_expires_at=expires_at,
            )
            db.add(user)
            db.commit()
            db.refresh(user)
        else:
            user.access_token = tok["access_token"]
            if tok.get("refresh_token"):
                user.refresh_token = tok["refresh_token"]
            user.token_expires_at = expires_at
            db.commit()
            db.refresh(user)
        api = SpotifyAPI(user.access_token, refresh=user.refresh_token, expires_at=user.token_expires_at)
        return api, user
    finally:
        db.close()



def fetch_me(access_token: str) -> dict:
    headers = {"Authorization": f"Bearer {access_token}"}
    settings = get_settings()
    with httpx.Client(timeout=settings.inference_timeout_seconds) as c:
        r = c.get("https://api.spotify.com/v1/me", headers=headers)
        r.raise_for_status()
        return r.json()


def authenticate_code(code: str, redirect_uri: str | None = None) -> "User":
    """Exchange an authorization code, fetch /me, upsert the User row."""
    tok = exchange_code(code, redirect_uri)
    me = fetch_me(tok["access_token"])
    payload = {
        "spotify_id": me.get("id", ""),
        "displayName": me.get("display_name", ""),
        "email": me.get("email", ""),
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token") or "",
        "expires_in": tok.get("expires_in", 3600),
    }
    from ..db import SessionLocal
    from ..models import User as U
    db = SessionLocal()
    try:
        existing = db.query(U).filter_by(spotify_id=payload["spotify_id"]).first()
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=payload["expires_in"])
        if existing is None:
            existing = U(
                spotify_id=payload["spotify_id"],
                display_name=payload["displayName"],
                email=payload["email"],
            )
            db.add(existing)
        existing.access_token = payload["access_token"]
        if payload["refresh_token"]:
            existing.refresh_token = payload["refresh_token"]
        existing.token_expires_at = expires_at
        existing.display_name = payload["displayName"]
        if payload["email"]:
            existing.email = payload["email"]
        db.commit()
        db.refresh(existing)
        return existing
    finally:
        db.close()
