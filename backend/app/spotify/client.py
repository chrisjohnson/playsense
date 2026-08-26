import httpx
from datetime import datetime, timedelta, timezone
from ..config import get_settings
from .auth import refresh_access_token


def _raise_or_json(r: httpx.Response):
    if r.status_code >= 400:
        raise RuntimeError(f"Spotify API {r.status_code}: {r.text[:500]}")
    try:
        return r.json()
    except ValueError:
        return {}


class SpotifyAPI:
    BASE = "https://api.spotify.com/v1"

    def __init__(self, access_token: str, refresh: str | None = None, expires_at=None, token_saver=None):
        self.access_token = access_token
        self._refresh = refresh
        self._token_saver = token_saver
        # Normalize any naive datetime to tz-aware UTC so expiry comparisons
        # never raise "can't compare offset-naive and offset-aware datetimes".
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        self._expires_at = expires_at
        self._http = httpx.Client(base_url=self.BASE, headers=self._headers(), timeout=30)

    def _headers(self):
        return {"Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json"}

    def _ensure_valid(self):
        exp = self._expires_at or (datetime.now(timezone.utc) + timedelta(hours=1))
        if datetime.now(timezone.utc) >= exp - timedelta(seconds=60):
            if not self._refresh:
                raise RuntimeError("Access token expired and no refresh token available; re-authenticate.")
            tok = refresh_access_token(self._refresh)
            self.access_token = tok["access_token"]
            self._expires_at = datetime.now(timezone.utc) + timedelta(seconds=tok.get("expires_in", 3600))
            if tok.get("refresh_token"):
                self._refresh = tok["refresh_token"]
            self._http.headers = self._headers()
            # Persist the rotated tokens so the next request (fresh client) does not
            # try to refresh with an already-invalidated refresh token.
            if self._token_saver:
                try:
                    self._token_saver(self.access_token, self._refresh, self._expires_at)
                except Exception:
                    pass

    def get(self, path: str, **kwargs):
        self._ensure_valid()
        return self._request(self._http.get, path, **kwargs)

    def post(self, path: str, **kwargs):
        self._ensure_valid()
        return self._request(self._http.post, path, **kwargs)

    def raw(self, method: str, path: str, **kwargs):
        self._ensure_valid()
        return self._request(getattr(self._http, method), path, **kwargs)

    def _request(self, fn, path, **kwargs):
        """Execute an API call, retrying with backoff on 429 (quota/rate limit)."""
        import time
        last_r = None
        for attempt in range(6):
            r = fn(path, **kwargs)
            last_r = r
            if r.status_code == 429:
                ra = r.headers.get("Retry-After")
                wait = int(ra) if (ra and ra.isdigit()) else 10 + attempt * 10
                time.sleep(min(wait, 65))
                continue
            return _raise_or_json(r)
        return _raise_or_json(last_r)
