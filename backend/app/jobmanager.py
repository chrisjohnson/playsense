"""Background classifier job manager (see docs/ai-classifiers.md).

The LLM is a data producer, never a query-time service. This manager turns
classifier definitions into pre-computed values:

1. It steps ONE job at a time (the LLM is a shared, flaky resource). A step
   is one bounded pass (PASS_SIZE tracks) through "tracks needing work" for
   the job's (classifier, playlist) scope - tracks with no current-revision
   row. Because classification is an upsert, a step is always resumable:
   interrupted work still "needs work" next time, and per-chunk commits keep
   partial work alive even across container restarts (the job row persists).

2. It auto-scans for work on every tick. New classifiers, staleness from a
   revision bump, and freshly downloaded tracks all surface as "no current
   row", so one count query per (classifier, playlist) finds everything -
   this is the design doc's "new-track hook", implemented as a scan rather
   than download-worker wiring. If work exists and no live job covers the
   scope, a job is enqueued.

3. Failed jobs retry automatically after a backoff - the model is expected
   to be flaky while the user develops it. Bad rows are never stored; they
   stay unclassified and are retried on a later pass.

Cancellation is cooperative: cancel switches a job to 'cancelling' and the
   running loop honors it between passes.
"""
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func

from .db import SessionLocal
from .models import Classifier, ClassifierJob, Playlist, Track, TrackClassification

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_thread: threading.Thread | None = None
_shutdown = threading.Event()

TICK_SECS = 10          # scan interval when idle / between steps
PASS_SIZE = 200         # tracks per pass (~8 LLM calls of 25)
RETRY_BACKOFF_SECS = 300  # error -> queued after this long


def start() -> None:
    global _thread
    with _lock:
        if _thread and _thread.is_alive():
            return
        _thread = threading.Thread(target=_loop, daemon=True, name="classifier-jobs")
        _thread.start()
        logger.info("classifier job manager started (tick=%ss, pass=%s)", TICK_SECS, PASS_SIZE)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _loop() -> None:
    while not _shutdown.is_set():
        try:
            _tick()
        except Exception:
            logger.exception("classifier job manager: tick failed")
        _shutdown.wait(TICK_SECS)


def _tick() -> None:
    db = SessionLocal()
    try:
        _step_job(db)
        _retry_errors(db)
        _autoscan(db)
        db.commit()
    finally:
        db.close()


def _needing(db, cls: Classifier, playlist_id: int) -> int:
    """Tracks in the playlist with no current-revision row for the classifier."""
    current = db.query(TrackClassification.track_id).filter(
        TrackClassification.classifier_id == cls.id,
        TrackClassification.classifier_revision == cls.revision)
    return db.query(func.count(Track.id)).filter(
        Track.playlist_id == playlist_id, Track.id.notin_(current)).scalar() or 0


def _has_live_job(db, classifier_id: int, playlist_id: int) -> bool:
    # 'cancelled' counts as live for the auto-scan: cancelling a job PAUSES its
    # scope (no surprise re-enqueue). Manual "Classify all" still works (it uses
    # _has_running_job), and a classifier revision bump lifts the pause by
    # deleting cancelled jobs.
    return db.query(ClassifierJob.id).filter(
        ClassifierJob.classifier_id == classifier_id,
        ClassifierJob.playlist_id == playlist_id,
        ClassifierJob.status.in_(["queued", "running", "cancelling", "error", "cancelled"]),
    ).first() is not None


def _has_running_job(db, classifier_id: int, playlist_id: int) -> bool:
    return db.query(ClassifierJob.id).filter(
        ClassifierJob.classifier_id == classifier_id,
        ClassifierJob.playlist_id == playlist_id,
        ClassifierJob.status.in_(["queued", "running", "cancelling", "error"]),
    ).first() is not None


def _summarize_error(msg: str) -> str:
    """Raw LLM/transport errors are litellm JSON blobs; the UI shows this,
    so keep it short and cause-only (the UI adds the retry schedule itself)."""
    m = (msg or "").lower()
    if "empty content" in m:
        return "LLM returned an empty response"
    if "inference 5" in m or "connection error" in m or ("connect" in m and "refused" in m):
        return "LLM unreachable (model backend down)"
    if "inference 4" in m:
        return "LLM rejected the request (HTTP 4xx) - check model config"
    if "timeout" in m:
        return "LLM timed out"
    return (msg or "unknown error")[:300]


def _fail(job: ClassifierJob, msg: str) -> None:
    job.status = "error"
    job.error = _summarize_error(msg)
    job.retry_after = _now() + timedelta(seconds=RETRY_BACKOFF_SECS)
    logger.warning("classifier job %s error: %s (raw: %s)", job.id, job.error, (msg or "")[:200])


def _step_job(db) -> None:
    """Advance the oldest active job by one pass (or promote a queued one)."""
    from .api.classifiers import run_classifier_pass  # local: avoid import cycle

    job = db.query(ClassifierJob).filter(
        ClassifierJob.status.in_(["running", "cancelling"]),
    ).order_by(ClassifierJob.id).first()
    if job is None:
        job = db.query(ClassifierJob).filter(
            ClassifierJob.status == "queued",
        ).order_by(ClassifierJob.id).first()
        if job is None:
            return
        job.status = "running"
        job.started_at = _now() if not job.started_at else job.started_at
        job.attempts = (job.attempts or 0) + 1
        db.commit()

    cls = db.get(Classifier, job.classifier_id)
    if cls is None:
        job.status = "done"  # classifier deleted; nothing left to do
        job.finished_at = _now()
        db.commit()
        return
    if not cls.field_type:
        _fail(job, "classifier has no field_type (inference pending or failed)")
        db.commit()
        return

    try:
        # share the tick's session + job row so the pass can update progress
        # per chunk (live UI stream) and a mid-pass restart loses no count
        res = run_classifier_pass(cls, playlist_id=job.playlist_id, limit=PASS_SIZE,
                                  offset=0, db=db, job=job)
    except HTTPException as e:
        _fail(job, str(e.detail))
    except Exception as e:
        _fail(job, f"{type(e).__name__}: {str(e)[:400]}")
    else:
        # progress was applied per chunk by the pass itself
        if res["processed"] == 0:
            job.status = "done"
            job.finished_at = _now()
            logger.info("classifier job %s done: classified=%s failed=%s",
                        job.id, job.done, job.failed)
        elif job.status == "cancelling":
            job.status = "cancelled"
            job.finished_at = _now()
            logger.info("classifier job %s cancelled after pass (done=%s)", job.id, job.done)
    db.commit()


def _retry_errors(db) -> None:
    now = _now()
    jobs = db.query(ClassifierJob).filter(
        ClassifierJob.status == "error",
        ClassifierJob.retry_after.isnot(None),
        ClassifierJob.retry_after <= now,
    ).all()
    for j in jobs:
        j.status = "queued"
        j.retry_after = None
        j.error = None  # fresh attempt: don't show the old failure while queued/running
        logger.info("classifier job %s back in queue after backoff", j.id)


def _autoscan(db) -> None:
    classifiers = db.query(Classifier).filter(Classifier.field_type.isnot(None)).all()
    playlists = db.query(Playlist).all()
    for pl in playlists:
        for c in classifiers:
            if _has_live_job(db, c.id, pl.id):
                continue
            n = _needing(db, c, pl.id)
            if n > 0:
                db.add(ClassifierJob(classifier_id=c.id, playlist_id=pl.id,
                                     status="queued", total=n))
                logger.info("auto-enqueued classifier job: classifier=%r playlist=%s tracks=%s",
                            c.name, pl.id, n)
