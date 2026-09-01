import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import httpx

from ..config import get_settings
from .auth import refresh_access_token


class SpotifyRateLimited(Exception):
    """429 from the rolling 30s rate-limit window (reason != QUOTA_EXCEEDED).
    The pacer has already been degraded; callers can back off and retry."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class SpotifyQuotaExceeded(Exception):
    """429 with reason=QUOTA_EXCEEDED: the developer account's quota budget is
    exhausted. Retrying immediately is useless; wait for the quota window to
    reset (the worker probes again after a delay)."""

    def __init__(self, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class Pacer:
    """Rolling 30s-window request pacer with an adaptive limit.

    Spotify counts rate limits in a rolling 30 second window per app. The
    dev-mode limit is not published, so we start conservative and adapt:
    degrade on rate-limit 429s, recover slowly while traffic stays clean.
    One shared instance per process: the quota is per developer account, so
    every SpotifyAPI client must draw from the same budget.
    """

    def __init__(self, default_limit: int | None = None):
        settings = get_settings()
        self.cap = default_limit or max(1, settings.spotify_max_req_per_30s)
        self.limit = self.cap
        self._events: deque = deque()
        self._lock = threading.Lock()
        self._last_429 = 0.0

    def _purge(self, now: float):
        while self._events and now - self._events[0] >= 30.0:
            self._events.popleft()

    def acquire(self):
        """Block until a request slot is available within the window."""
        while True:
            with self._lock:
                now = time.monotonic()
                self._purge(now)
                if len(self._events) < self.limit:
                    self._events.append(now)
                    return
                wait = 30.0 - (now - self._events[0]) + 0.05
            time.sleep(max(wait, 0.1))

    def degrade(self):
        with self._lock:
            self.limit = max(1, self.limit // 2)
            self._last_429 = time.monotonic()

    def maybe_recover(self):
        with self._lock:
            if self.limit < self.cap and time.monotonic() - self._last_429 > 120:
                self.limit = min(self.cap, self.limit + 1)

    def status(self) -> dict:
        with self._lock:
            return {"limit_per_30s": self.limit, "cap_per_30s": self.cap}


DEFAULT_PACER = Pacer()


def _parse_429(r: httpx.Response) -> tuple:
    ra = r.headers.get("Retry-After")
    retry_after = int(ra) if (ra and ra.isdigit()) else None
    reason = ""
    try:
        body = r.json()
        reason = str((body.get("error") or {}).get("reason") or "").upper()
    except Exception:
        pass
    return reason, retry_after


def _raise_or_json(r: httpx.Response):
    if r.status_code >= 400:
        raise RuntimeError(f"Spotify API {r.status_code}: {r.text[:500]}")
    try:
        return r.json()
    except ValueError:
        return {}


class SpotifyAPI:
    BASE = "https://api.spotify.com/v1"

    def __init__(self, access_token: str, refresh: str | None = None, expires_at=None,
                 token_saver=None, pacer: Pacer | None = None):
        self.access_token = access_token
        self._refresh = refresh
        self._token_saver = token_saver
        # Normalize any naive datetime to tz-aware UTC so expiry comparisons
        # never raise "can't compare offset-naive and offset-aware datetimes".
        if expires_at is not None and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        self._expires_at = expires_at
        self._http = httpx.Client(base_url=self.BASE, headers=self._headers(), timeout=30)
        self._pacer = pacer or DEFAULT_PACER

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
        """Execute an API call through the shared pacer.

        Rate-limit 429s (rolling window) degrade the pacer and are retried.
        Quota 429s (reason=QUOTA_EXCEEDED) are NOT retried in a hot loop —
        they propagate as SpotifyQuotaExceeded so the caller can wait for the
        quota window to reset.
        """
        last_text = ""
        for attempt in range(6):
            self._pacer.acquire()
            r = fn(path, **kwargs)
            if r.status_code == 429:
                last_text = r.text[:300]
                reason, retry_after = _parse_429(r)
                if reason == "QUOTA_EXCEEDED":
                    raise SpotifyQuotaExceeded(
                        f"Spotify quota exceeded (developer-account budget exhausted): {last_text}",
                        retry_after=retry_after)
                self._pacer.degrade()
                wait = retry_after if retry_after is not None else 35
                time.sleep(min(wait, 120))
                continue
            self._pacer.maybe_recover()
            return _raise_or_json(r)
        raise SpotifyRateLimited(f"Spotify rate limited after retries: {last_text}")
