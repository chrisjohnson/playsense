"""Background download worker.

Spotify's dev-mode quota is a small per-developer budget that resets on a
long window (typically ~daily), and the Feb-2026 API caps playlist pages at
50 tracks — so a large playlist cannot be fetched in one burst. This worker
grinds: it resumes the current download page by page (progress is committed
per page into the bind-mounted DB), pauses when the quota is exhausted, and
probes again after a delay. Container restarts never lose progress.
"""
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone

from ..config import get_settings
from ..db import SessionLocal
from ..models import Playlist
from .client import SpotifyQuotaExceeded, SpotifyRateLimited
from .download import download_playlist, get_or_create_api

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_queue: deque = deque()
_in_queue: set = set()
_thread: threading.Thread | None = None
_shutdown = threading.Event()


def enqueue(playlist_db_id: int) -> bool:
    with _lock:
        if playlist_db_id in _in_queue:
            return False
        _in_queue.add(playlist_db_id)
        _queue.append(playlist_db_id)
    logger.info("download enqueued: playlist %s", playlist_db_id)
    return True


def start():
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _shutdown.clear()
        _thread = threading.Thread(target=_loop, name="spotify-download-worker", daemon=True)
        _thread.start()
        logger.info("download worker started")


def _set_state(pl_id: int, state: str, error: str = "", clear_error: bool = False):
    db = SessionLocal()
    try:
        pl = db.get(Playlist, pl_id)
        if pl is None:
            return
        pl.download_state = state
        if clear_error:
            pl.download_error = ""
        elif error:
            pl.download_error = error[:1000]
        pl.download_updated_at = datetime.now(timezone.utc)
        db.commit()
    finally:
        db.close()


def _requeue_pending():
    """On startup, resume anything that was in flight when we restarted."""
    db = SessionLocal()
    try:
        rows = db.query(Playlist).filter(
            Playlist.download_state.in_(["queued", "downloading", "waiting_quota"])).all()
        for p in rows:
            p.download_state = "queued"
            p.download_error = ""
            db.commit()
            enqueue(p.id)
            logger.info("resumed pending download for playlist %s (%s rows saved)",
                        p.id, p.download_saved)
    finally:
        db.close()


def _loop():
    settings = get_settings()
    probe_wait = max(300, settings.spotify_quota_probe_seconds)
    _requeue_pending()
    while not _shutdown.is_set():
        with _lock:
            pl_id = None
            while not _queue:
                _lock.release()
                _shutdown.wait(2)
                _lock.acquire()
            if not _shutdown.is_set() and _queue:
                pl_id = _queue.popleft()
        if pl_id is None:
            break
        try:
            _process(pl_id, probe_wait)
        except Exception as e:
            logger.exception("download worker error for playlist %s", pl_id)
            _set_state(pl_id, "error", f"worker error: {str(e)[:300]}")
        finally:
            with _lock:
                _in_queue.discard(pl_id)


def _process(pl_id: int, probe_wait: int):
    _set_state(pl_id, "downloading", clear_error=True)
    while not _shutdown.is_set():
        try:
            api = get_or_create_api()
            if api is None:
                _set_state(pl_id, "error", "Not authenticated — connect to Spotify")
                return
            result = download_playlist(api, pl_id)
            if result["state"] == "done":
                return
        except SpotifyRateLimited as e:
            # Rate-limit window still saturated after retries: back off and retry.
            _set_state(pl_id, "downloading", f"rate limited — backing off ({str(e)[:150]})")
            _shutdown.wait(300)
        except SpotifyQuotaExceeded as e:
            wait = probe_wait
            if e.retry_after and e.retry_after < 21600:
                wait = max(int(e.retry_after), 300)
            _set_state(pl_id, "waiting_quota",
                       "Spotify quota exhausted — resuming automatically")
            logger.info("playlist %s: quota exhausted; next probe in %ss", pl_id, wait)
            _shutdown.wait(wait)
        except RuntimeError as e:
            msg = str(e)
            low = msg.lower()
            if "not authenticated" in low or "re-authenticate" in low:
                _set_state(pl_id, "error", "Spotify session expired — click Connect to re-authenticate")
                return
            # Transient failure (rate limit after retries, 5xx, network): back off.
            _set_state(pl_id, "downloading", f"retrying: {msg[:300]}")
            _shutdown.wait(300)
    logger.info("worker shutting down (playlist %s); progress is saved and will resume on next start",
                pl_id)
