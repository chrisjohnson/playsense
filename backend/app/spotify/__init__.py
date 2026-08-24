__all__ = ["download_playlist", "list_playlists", "ensure_playlist", "get_or_create_api", "save_user_from_token"]
from .download import download_playlist, list_playlists, ensure_playlist
from .auth import save_user_from_token
from .client import SpotifyAPI

def get_or_create_api():
    from ..db import SessionLocal
    from ..models import User
    db = SessionLocal()
    try:
        user = db.query(User).first()
        if not user:
            return None
        return SpotifyAPI(user.access_token, refresh=user.refresh_token, expires_at=user.token_expires_at)
    finally:
        db.close()
