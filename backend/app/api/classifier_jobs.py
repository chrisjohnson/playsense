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


def _out(j: ClassifierJob) -> dict:
    return {
        "id": j.id,
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
    return [_out(j) for j in jobs]


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
    created, skipped = [], []
    for pid in playlist_ids:
        if _has_running_job(db, cls.id, pid):  # paused (cancelled) scopes are enqueuable
            skipped.append(pid)
            continue
        n = _needing(db, cls, pid)
        job = ClassifierJob(classifier_id=cls.id, playlist_id=pid, status="queued", total=n)
        db.add(job)
        created.append(job)
    db.commit()
    return {"created": [_out(j) for j in created], "skipped_playlists": skipped}


@router.post("/{job_id}/cancel")
def cancel_job(job_id: int, db=Depends(get_db)):
    job = db.get(ClassifierJob, job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status == "queued":
        job.status = "cancelled"
        job.finished_at = utcnow()
    elif job.status == "running":
        # cooperative: the manager honors it between passes
        job.status = "cancelling"
    else:
        raise HTTPException(409, f"Job is not active (status={job.status})")
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
