"""Job management API for classifier batch runs (docs/ai-classifiers.md §4).

The job manager (app/jobmanager.py) auto-enqueues work and steps it; this
router adds the manual controls: list jobs with progress, enqueue a scope on
demand, cancel, and drop terminal jobs.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from ..db import SessionLocal, get_db
from ..models import Classifier, ClassifierJob, Playlist, utcnow

router = APIRouter(prefix="/classifier-jobs", tags=["classifier-jobs"])

TERMINAL = {"done", "error", "cancelled"}


def _state(j: ClassifierJob) -> str:
    """Human-facing state. In this manager an `error` job is never actually
    broken: _fail() always schedules a retry_after, and _retry_errors() puts
    it back in the queue. So `error` + retry_after reads as 'retrying' (this
    step hit a transient failure and is auto-resuming), not 'failed'. A
    terminal `error` (no retry_after) is effectively unreachable today but is
    kept distinct in case that ever changes."""
    if j.status == "error":
        return "retrying" if j.retry_after else "failed"
    return j.status


def _out(j: ClassifierJob) -> dict:
    return {
        "id": j.id,
        "state": _state(j),
        "classifier_id": j.classifier_id,
        "classifier_name": j.classifier.name if j.classifier else None,
        "playlist_id": j.playlist_id,
        "playlist_name": j.playlist.name if j.playlist else None,
        "status": j.status,
        "total": j.total,
        "done": j.done,
        "failed": j.failed,
        "attempts": j.attempts,
        "error": j.error or "",
        "created_at": j.created_at.isoformat() if j.created_at else None,
        "started_at": j.started_at.isoformat() if j.started_at else None,
        "finished_at": j.finished_at.isoformat() if j.finished_at else None,
        "retry_after": j.retry_after.isoformat() if j.retry_after else None,
    }


@router.get("")
def list_jobs(db=Depends(get_db)):
    jobs = db.query(ClassifierJob).order_by(ClassifierJob.id.desc()).limit(50).all()
    from ..jobmanager import _needing
    out = []
    for j in jobs:
        o = _out(j)
        # Reality check for the UI: the job's `total` is an enqueue-time
        # snapshot, so a done job can read 4,224/4,649 while the scope is
        # actually fully classified (playlist grew mid-run / later job
        # finished the rest). needing = tracks in the scope with no
        # current-revision value RIGHT NOW. The UI shows 'partial' + Resume
        # only when this is > 0.
        cls = db.get(Classifier, j.classifier_id)
        pl = db.get(Playlist, j.playlist_id)
        o["needing"] = _needing(db, cls, j.playlist_id) if (cls and pl) else 0
        out.append(o)
    return out


class EnqueueBody(BaseModel):
    classifier_id: int
    playlist_id: Optional[int] = None  # omit -> one job per playlist with work


@router.post("")
def enqueue_jobs(body: EnqueueBody, db=Depends(get_db)):
    cls = db.get(Classifier, body.classifier_id)
    if cls is None:
        raise HTTPException(404, "Classifier not found")
    if not cls.field_type:
        raise HTTPException(409, "Classifier has no field_type yet (inference pending)")

    if body.playlist_id is not None:
        if db.get(Playlist, body.playlist_id) is None:
            raise HTTPException(404, "Playlist not found")
        playlist_ids = [body.playlist_id]
    else:
        playlist_ids = [p.id for p in db.query(Playlist).all()]

    from ..jobmanager import _has_running_job, _needing
    created, skipped, no_work = [], [], []
    for pid in playlist_ids:
        if _has_running_job(db, cls.id, pid):  # paused (cancelled) scopes are enqueuable
            skipped.append(pid)
            continue
        n = _needing(db, cls, pid)
        if n == 0:
            no_work.append(pid)  # empty playlist / fully classified: no job needed
            continue
        job = ClassifierJob(classifier_id=cls.id, playlist_id=pid, status="queued", total=n)
        db.add(job)
        created.append(job)
    db.commit()
    return {"created": [_out(j) for j in created], "skipped_playlists": skipped,
            "no_work_playlists": no_work}


@router.post("/{job_id}/cancel")
def cancel_job(job_id: int, db=Depends(get_db)):
    job = db.get(ClassifierJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = utcnow()
    elif job.status == "running":
        # cooperative: the manager honors it at the next chunk boundary
        job.status = "cancelling"
    elif job.status == "cancelling":
        pass  # already stopping - idempotent, no-op
    else:
        raise HTTPException(409, f"Job is not active (status={job.status})")
    db.commit()
    return _out(job)


@router.post("/{job_id}/retry")
def retry_job(job_id: int, db=Depends(get_db)):
    """Send an error/cancelled job straight back to the front of the queue
    (skips the backoff)."""
    job = db.get(ClassifierJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status not in ("error", "cancelled"):
        raise HTTPException(409, f"Only error/cancelled jobs can be retried (status={job.status})")
    job.status = "queued"
    job.retry_after = None
    job.error = None  # fresh attempt: don't show the old failure while queued/running
    db.commit()
    return _out(job)


@router.delete("/{job_id}")
def delete_job(job_id: int, db=Depends(get_db)):
    job = db.get(ClassifierJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status not in TERMINAL:
        raise HTTPException(409, "Cancel the job first")
    db.delete(job)
    db.commit()
    return {"status": "deleted"}
