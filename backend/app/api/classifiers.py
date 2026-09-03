from __future__ import annotations

import json
import logging
import time
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import func

from ..db import SessionLocal
from ..models import Track, Classifier, TrackClassification
from ..inference.adapter import InferenceAdapter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/classifiers", tags=["classifiers"])

FIELD_TYPES = ("boolean", "string", "number", "datetime")
CHUNK_SIZE = 25  # tracks per LLM call - keeps prompts small (see design doc §4)
CHUNK_RETRIES = 3   # attempts per chunk before the pass fails
CHUNK_RETRY_WAIT = 15  # seconds between attempts - medium-moe flaps clear in seconds,
                       # sustained outages fall through to the job-level 5-min backoff


class ClassifierIn(BaseModel):
    name: str
    query: str
    field_type: str | None = None  # omitted -> infer via a 1st-pass LLM call


class ClassifierUpdate(BaseModel):
    name: str | None = None
    query: str | None = None
    field_type: str | None = None


class RunIn(BaseModel):
    playlist_id: int | None = None
    limit: int = 100  # bounded pass (MVP: synchronous; the job manager reuses this core)
    offset: int = 0


class ExplainIn(BaseModel):
    track_id: int


class PreviewIn(BaseModel):
    query: str
    field_type: str | None = None  # omitted -> infer via a 1st-pass LLM call (same as create)
    track_ids: list[int]


# ---------------------------------------------------------------------------
# value handling (loose JSON storage, strict validation at write time)
# ---------------------------------------------------------------------------


def validate_value(field_type: str | None, v):
    """Coerce+validate a raw LLM value for the classifier's field type.
    Returns (ok, normalized_json_text)."""
    if field_type is None:
        return False, None
    if field_type == "boolean":
        if isinstance(v, bool):
            return True, json.dumps(v)
        if isinstance(v, int) and v in (0, 1):
            return True, json.dumps(bool(v))
        if isinstance(v, str) and v.strip().lower() in ("true", "false"):
            return True, json.dumps(v.strip().lower() == "true")
        return False, None
    if field_type == "string":
        if isinstance(v, str) and v.strip():
            return True, json.dumps(v.strip())
        return False, None
    if field_type == "number":
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return True, json.dumps(v)
        return False, None
    if field_type == "datetime":
        if isinstance(v, str):
            try:
                datetime.fromisoformat(v.replace("Z", "+00:00"))
                return True, json.dumps(v)
            except ValueError:
                return False, None
        return False, None
    return False, None


def schema_for(field_type: str | None) -> dict:
    """The per-track value schema the LLM must conform to."""
    vt = {
        "boolean": {"type": "boolean"},
        "string": {"type": "string"},
        "number": {"type": "number"},
        "datetime": {"type": "string", "description": "ISO 8601 date or datetime"},
    }.get(field_type, {"type": "string"})
    return {
        "type": "object",
        "properties": {
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer"},
                        "value": vt,
                        "reason": {"type": "string"},
                    },
                    "required": ["index", "value"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["results"],
        "additionalProperties": False,
    }


# ---------------------------------------------------------------------------
# execution core (chunked batch pass) - reused by the future job manager
# ---------------------------------------------------------------------------


def _track_line(i: int, t: Track) -> str:
    try:
        artists = [a.get("name", "") for a in json.loads(t.artists or "[]")]
    except (json.JSONDecodeError, AttributeError):
        artists = []
    dur_s = round(t.duration_ms / 1000) if t.duration_ms else None
    return (f"{i}: title=\"{t.name}\" artists=[{', '.join(artists)}] "
            f"album=\"{t.album_name or '?'}\" year={ (t.release_date or '?')[:4] } "
            f"duration_s={dur_s}")


def _artists_list(t: Track) -> list[str]:
    try:
        return [a.get("name", "") for a in json.loads(t.artists or "[]") if isinstance(a, dict)]
    except (json.JSONDecodeError, AttributeError):
        return []


def _system_prompt(query: str, field_type: str) -> str:
    schema = schema_for(field_type)
    return (
        "You are a strict metadata classifier. You receive one classification question "
        "and a numbered list of music tracks. For EACH track, decide its value for the "
        "question using only the metadata shown. Respond with JSON matching EXACTLY this "
        "schema:\n" + json.dumps(schema, indent=1) +
        "\nRules: include one entry per track index, never skip an index; the value type "
        "must match the schema; keep 'reason' to one short clause; if the metadata is "
        "inconclusive, still answer your best judgment."
    )


def _track_out(t: Track) -> dict:
    return {"id": t.id, "name": t.name, "artists": _artists_list(t),
            "album_name": t.album_name, "release_date": (t.release_date or None)}


def run_classifier_pass(cls: Classifier, playlist_id: int | None = None,
                        limit: int = 100, offset: int = 0,
                        db=None, job=None) -> dict:
    """Classify up to `limit` tracks that lack a CURRENT value for this
    classifier (stale = older revision counts as needing work). Synchronous
    bounded pass; returns progress. Raises on LLM failure after the partial
    work is committed (per-chunk upserts survive).

    db/job: when the job manager calls this it passes its own session and job
    row so progress is applied per chunk (live UI stream) and a mid-pass
    restart loses no count. The /run endpoint omits both."""
    owns_db = db is None
    if owns_db:
        db = SessionLocal()
    try:
        if cls.field_type is None:
            raise HTTPException(409, "Classifier has no field_type yet; infer or set it first.")
        # Tracks needing work = tracks with NO current-revision row (a stale
        # row simply gets upserted). Bump revision -> everything needs work.
        stmt = db.query(Track)
        if playlist_id is not None:
            stmt = stmt.filter(Track.playlist_id == playlist_id)
        current_ids = db.query(TrackClassification.track_id).filter(
            TrackClassification.classifier_id == cls.id,
            TrackClassification.classifier_revision == cls.revision)
        stmt = stmt.filter(Track.id.notin_(current_ids))
        tracks = stmt.order_by(Track.id).offset(offset).limit(limit).all()

        llm = InferenceAdapter()
        schema = schema_for(cls.field_type)
        system = _system_prompt(cls.query, cls.field_type)

        done = ok = failed = 0
        cancelled = False
        for i in range(0, len(tracks), CHUNK_SIZE):
            # Cancellation is cooperative but checked at CHUNK granularity:
            # a concurrent cancel flips the DB status from another session, so
            # re-read it (the in-memory job row goes stale during the long LLM
            # calls). Stop before starting the next chunk.
            if job is not None:
                db.refresh(job)
                if job.status == "cancelling":
                    cancelled = True
                    break
            chunk_ok = chunk_failed = 0
            chunk = tracks[i:i + CHUNK_SIZE]
            lines = "\n".join(_track_line(j, t) for j, t in enumerate(chunk))
            user = f"Classification question: {cls.query}\n\nTracks:\n{lines}"
            # Chunk-level retry: the model flaps (HTTP 500 / empty content /
            # malformed JSON) on single calls. A quick inline retry clears the
            # blip without idling the whole job for the 5-min backoff; if all
            # attempts fail the pass raises and the job-level backoff takes over.
            data = None
            for attempt in range(1, CHUNK_RETRIES + 1):
                try:
                    content = llm.chat_structured([
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ], schema)
                    data = json.loads(content)
                    break
                except Exception as e:
                    if attempt >= CHUNK_RETRIES:
                        raise
                    logger.warning("classifier %s chunk %d attempt %d/%d failed: %s - retrying in %ds",
                                   cls.id, i // CHUNK_SIZE, attempt, CHUNK_RETRIES, str(e)[:150], CHUNK_RETRY_WAIT)
                    if job is not None:
                        db.refresh(job)
                        if job.status == "cancelling":
                            cancelled = True
                            break
                    time.sleep(CHUNK_RETRY_WAIT)
            if cancelled:
                break
            entries = {e.get("index"): e for e in (data.get("results") or []) if isinstance(e, dict)}
            for j, t in enumerate(chunk):
                done += 1
                e = entries.get(j)
                if e is None:
                    failed += 1
                    chunk_failed += 1
                    continue
                good, val_json = validate_value(cls.field_type, e.get("value"))
                if not good:
                    failed += 1
                    chunk_failed += 1
                    continue
                row = db.query(TrackClassification).filter_by(
                    track_id=t.id, classifier_id=cls.id).first()
                if row is None:
                    row = TrackClassification(track_id=t.id, classifier_id=cls.id)
                    db.add(row)
                row.classifier_revision = cls.revision
                row.value = val_json
                row.reason = str(e.get("reason") or "")[:300]
                row.classified_at = datetime.utcnow()
                ok += 1
                chunk_ok += 1
            if job is not None:
                # apply progress in the SAME transaction as the rows, so the
                # job count and the data never disagree (and survive restarts)
                job.done = (job.done or 0) + chunk_ok
                job.failed = (job.failed or 0) + chunk_failed
            db.commit()  # per-chunk commit: partial work survives LLM failures
        return {"requested": limit, "processed": len(tracks), "classified": ok,
                "failed": failed, "done": done}
    finally:
        if owns_db:
            db.close()


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


def _classifier_out(c: Classifier, total: int) -> dict:
    db = SessionLocal()
    try:
        current = db.query(func.count(TrackClassification.id)).filter(
            TrackClassification.classifier_id == c.id,
            TrackClassification.classifier_revision == c.revision).scalar() or 0
        stale = db.query(func.count(TrackClassification.id)).filter(
            TrackClassification.classifier_id == c.id,
            TrackClassification.classifier_revision != c.revision).scalar() or 0
        true_count = None
        if c.field_type == "boolean":
            # how many current values are `true` (the Search checkbox pass count)
            true_count = db.query(func.count(TrackClassification.id)).filter(
                TrackClassification.classifier_id == c.id,
                TrackClassification.classifier_revision == c.revision,
                TrackClassification.value == "true").scalar() or 0
    finally:
        db.close()
    return {
        "id": c.id, "name": c.name, "query": c.query, "field_type": c.field_type,
        "revision": c.revision, "created_at": c.created_at, "updated_at": c.updated_at,
        "stats": {"total": total, "current": current, "stale": stale,
                  "unclassified": max(0, total - current - stale),
                  "true_count": true_count},
    }


@router.get("")
def list_classifiers():
    db = SessionLocal()
    try:
        total = db.query(func.count(Track.id)).scalar() or 0
        rows = db.query(Classifier).order_by(Classifier.id).all()
        return [_classifier_out(c, total) for c in rows]
    finally:
        db.close()


@router.post("")
def create_classifier(body: ClassifierIn):
    if body.field_type is not None and body.field_type not in FIELD_TYPES:
        raise HTTPException(422, f"field_type must be one of {list(FIELD_TYPES)}")
    field_type = body.field_type
    inferred = False
    if field_type is None:
        # 1st-pass LLM call: what kind of value does this question produce?
        try:
            llm = InferenceAdapter()
            content = llm.chat_structured([
                {"role": "system", "content": (
                    "You decide the answer type for a track-classification question. "
                    "Respond with JSON: {\"field_type\": <one of: boolean, string, number, datetime>, "
                    "\"reason\": \"short\"}. boolean = yes/no per track; string = a label/phrase; "
                    "number = a numeric score; datetime = a date.")},
                {"role": "user", "content": f"Question: {body.query}"},
            ], {"type": "object", "properties": {"field_type": {"type": "string"}, "reason": {"type": "string"}}})
            ft = (json.loads(content).get("field_type") or "").strip().lower()
            if ft in FIELD_TYPES:
                field_type, inferred = ft, True
        except Exception:
            pass  # inference failed -> field stays untyped (hidden in search) until set
    db = SessionLocal()
    try:
        c = Classifier(name=body.name.strip()[:255], query=body.query.strip(),
                       field_type=field_type, revision=1)
        db.add(c)
        db.commit()
        db.refresh(c)
        return {"classifier": _classifier_out(c, db.query(func.count(Track.id)).scalar() or 0),
                "inferred": inferred}
    finally:
        db.close()


@router.put("/{cid}")
def update_classifier(cid: int, body: ClassifierUpdate):
    db = SessionLocal()
    try:
        c = db.get(Classifier, cid)
        if c is None:
            raise HTTPException(404, "Classifier not found")
        changed = False
        if body.name is not None and body.name.strip() and body.name.strip() != c.name:
            c.name = body.name.strip()[:255]
        if body.query is not None and body.query.strip() and body.query.strip() != c.query:
            c.query = body.query.strip()
            changed = True  # redefinition -> every stored value becomes stale
        if body.field_type is not None:
            if body.field_type not in FIELD_TYPES:
                raise HTTPException(422, f"field_type must be one of {list(FIELD_TYPES)}")
            if body.field_type != c.field_type:
                c.field_type = body.field_type
                changed = True  # type change -> old values don't parse as the new type
        if changed:
            c.revision += 1
            c.updated_at = datetime.utcnow()
            # redefinition = new work: lift any pause from cancelled jobs so the
            # auto-scan re-enqueues this classifier's scopes
            from ..models import ClassifierJob
            db.query(ClassifierJob).filter(
                ClassifierJob.classifier_id == cid,
                ClassifierJob.status == "cancelled",
            ).delete(synchronize_session=False)
        db.commit()
        db.refresh(c)
        return _classifier_out(c, db.query(func.count(Track.id)).scalar() or 0)
    finally:
        db.close()


@router.post("/{cid}/rerun")
def rerun_classifier(cid: int):
    """Force a full re-classification without changing the definition.

    Bumps the revision (every stored value becomes stale) and the job
    manager's auto-scan re-enqueues jobs for every playlist on the next
    tick. This is the trigger for changes the revision system can't see on
    its own: a new model, changed prompt plumbing, or changed source
    metadata (e.g. dropping a field the classifier was seeing).
    """
    db = SessionLocal()
    try:
        c = db.get(Classifier, cid)
        if c is None:
            raise HTTPException(404, "Classifier not found")
        c.revision += 1
        c.updated_at = datetime.utcnow()
        # same as a redefinition: lift any pause from cancelled jobs so the
        # auto-scan re-enqueues this classifier's scopes
        from ..models import ClassifierJob
        db.query(ClassifierJob).filter(
            ClassifierJob.classifier_id == cid,
            ClassifierJob.status == "cancelled",
        ).delete(synchronize_session=False)
        db.commit()
        db.refresh(c)
        return _classifier_out(c, db.query(func.count(Track.id)).scalar() or 0)
    finally:
        db.close()


@router.delete("/{cid}")
def delete_classifier(cid: int):
    db = SessionLocal()
    try:
        from ..models import ClassifierJob
        c = db.get(Classifier, cid)
        if c is None:
            raise HTTPException(404, "Classifier not found")
        # drop any jobs (live ones stop being stepped once the classifier is gone)
        db.query(ClassifierJob).filter(ClassifierJob.classifier_id == cid).delete(synchronize_session=False)
        db.delete(c)  # cascade deletes track_classifications rows
        db.commit()
        return {"status": "deleted"}
    finally:
        db.close()


@router.post("/{cid}/run")
def run_classifier(cid: int, body: RunIn):
    db = SessionLocal()
    try:
        c = db.get(Classifier, cid)
        if c is None:
            raise HTTPException(404, "Classifier not found")
    finally:
        db.close()
    try:
        return {"classifier_id": cid, **run_classifier_pass(c, body.playlist_id,
                                                            max(1, body.limit), body.offset)}
    except HTTPException:
        raise
    except Exception as e:
        # partial work is already committed per chunk; report what failed
        raise HTTPException(502, f"Classifier run failed mid-pass: {str(e)[:300]}")


def _extract_explanation(content: str) -> str:
    """Pull the human-readable explanation out of a model reply. Models
    comply with 'respond with JSON' variously: bare JSON, JSON wrapped in a
    ```json fence, a bare string, or plain prose. All of these should come
    back as plain text, never as a raw fenced blob."""
    import re
    t = (content or "").strip()
    m = re.match(r"^```[a-zA-Z0-9]*\s*\n?(.*?)\n?```\s*$", t, re.S)
    if m:
        t = m.group(1).strip()
    try:
        data = json.loads(t)
    except (json.JSONDecodeError, TypeError):
        return t
    if isinstance(data, dict):
        for k in ("explanation", "reason", "answer", "text"):
            v = data.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    if isinstance(data, str) and data.strip():
        return data.strip()
    return t


@router.post("/{cid}/explain")
def explain_value(cid: int, body: ExplainIn):
    """Re-ask the LLM for a detailed, plain-language explanation of why one
    track was assigned its stored value. A single-track call (tiny prompt), so
    it is far more robust than the 25-track batch. The returned `explanation`
    is a fresh re-derivation; `recorded_reason` is the short clause captured
    at classification time (returned alongside for reference)."""
    db = SessionLocal()
    try:
        c = db.get(Classifier, cid)
        if c is None:
            raise HTTPException(404, "Classifier not found")
        t = db.get(Track, body.track_id)
        if t is None:
            raise HTTPException(404, "Track not found")
        row = db.query(TrackClassification).filter_by(
            track_id=t.id, classifier_id=c.id).first()
        recorded_reason = (row.reason or "") if row else ""
        try:
            value = json.loads(row.value) if (row and row.value) else None
        except (json.JSONDecodeError, TypeError):
            value = None
    finally:
        db.close()

    system = (
        "You are an expert music-metadata analyst. You are given one "
        "classification question, one music track, and the value that was "
        "assigned to it. Explain in detail, in plain language, WHY that value "
        "is the right answer for this track. Cite the specific metadata "
        "(artist, album, language, era, etc.) that supports it. If the answer "
        "was a best-judgment call under uncertainty, say so and what would "
        "change your mind. Respond with JSON: {\"explanation\": \"2-5 sentences\"}"
    )
    user = (
        f"Classification question: {c.query}\n"
        f"Field type: {c.field_type}\n"
        f"Assigned value: {json.dumps(value)}\n"
        f"Track:\n{_track_line(1, t)}"
        + (f"\nRecorded reason at classification: {recorded_reason}" if recorded_reason else "")
    )
    try:
        llm = InferenceAdapter()
        content = llm.chat([{"role": "system", "content": system},
                            {"role": "user", "content": user}])
        explanation = _extract_explanation(content)
    except Exception as e:
        raise HTTPException(502, f"Explanation unavailable (LLM): {str(e)[:200]}")
    return {"classifier_id": c.id, "classifier": c.name, "query": c.query,
            "field_type": c.field_type, "value": value,
            "recorded_reason": recorded_reason, "explanation": explanation}


# ---------------------------------------------------------------------------
# Preview: run a (possibly unsaved) query on a chosen set of tracks WITHOUT
# storing anything. This is the "try it before you commit it" path for the
# add/edit modal - same prompt, schema, chunking and retries as the batch
# pass, but results go straight back to the UI.
# ---------------------------------------------------------------------------

PREVIEW_MAX_TRACKS = 50  # 2 LLM calls max - keep it a preview, not a batch


@router.post("/preview")
def preview_classifier(body: PreviewIn):
    query = body.query.strip()
    if not query:
        raise HTTPException(422, "query is required")
    if not body.track_ids:
        raise HTTPException(422, "track_ids is required")
    if len(body.track_ids) > PREVIEW_MAX_TRACKS:
        raise HTTPException(422, f"preview is capped at {PREVIEW_MAX_TRACKS} tracks (2 LLM calls)")
    field_type = body.field_type
    inferred = False
    if field_type is not None and field_type not in FIELD_TYPES:
        raise HTTPException(422, f"field_type must be one of {list(FIELD_TYPES)}")

    db = SessionLocal()
    try:
        tracks = db.query(Track).filter(Track.id.in_(body.track_ids)).order_by(Track.id).all()
    finally:
        db.close()
    if not tracks:
        raise HTTPException(404, "No matching tracks")

    if field_type is None:
        # same 1st-pass inference as create; if it fails, ask for an explicit type
        try:
            llm = InferenceAdapter()
            content = llm.chat_structured([
                {"role": "system", "content": (
                    "You decide the answer type for a track-classification question. "
                    "Respond with JSON: {\"field_type\": <one of: boolean, string, number, datetime>, "
                    "\"reason\": \"short\"}. boolean = yes/no per track; string = a label/phrase; "
                    "number = a numeric score; datetime = a date.")},
                {"role": "user", "content": f"Question: {query}"},
            ], {"type": "object", "properties": {"field_type": {"type": "string"}, "reason": {"type": "string"}}})
            ft = (json.loads(content).get("field_type") or "").strip().lower()
            if ft in FIELD_TYPES:
                field_type, inferred = ft, True
        except Exception:
            pass
        if field_type is None:
            raise HTTPException(422, "Could not infer the field type - pick one explicitly")

    t0 = time.time()
    llm = InferenceAdapter()
    schema = schema_for(field_type)
    system = _system_prompt(query, field_type)
    results = []
    try:
        for i in range(0, len(tracks), CHUNK_SIZE):
            chunk = tracks[i:i + CHUNK_SIZE]
            lines = "\n".join(_track_line(j, t) for j, t in enumerate(chunk))
            user = f"Classification question: {query}\n\nTracks:\n{lines}"
            data = None
            for attempt in range(1, CHUNK_RETRIES + 1):
                try:
                    content = llm.chat_structured([
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ], schema)
                    data = json.loads(content)
                    break
                except Exception as e:
                    if attempt >= CHUNK_RETRIES:
                        raise
                    logger.warning("preview chunk %d attempt %d/%d failed: %s - retrying in %ds",
                                   i // CHUNK_SIZE, attempt, CHUNK_RETRIES, str(e)[:150], CHUNK_RETRY_WAIT)
                    time.sleep(CHUNK_RETRY_WAIT)
            entries = {e.get("index"): e for e in (data.get("results") or []) if isinstance(e, dict)}
            for j, t in enumerate(chunk):
                e = entries.get(j)
                good, val = validate_value(field_type, e.get("value") if e is not None else None)
                results.append({
                    "track_id": t.id, "name": t.name, "artists": _artists_list(t),
                    "value": val if good else None, "value_ok": good and e is not None,
                    "reason": str(e.get("reason") or "")[:300] if e is not None else "",
                })
    except Exception as e:
        raise HTTPException(502, f"Preview unavailable (LLM): {str(e)[:200]}")
    return {"query": query, "field_type": field_type, "inferred": inferred,
            "results": results, "chunks": (len(tracks) + CHUNK_SIZE - 1) // CHUNK_SIZE,
            "elapsed_ms": int((time.time() - t0) * 1000)}


@router.get("/track-search")
def track_search(q: str = "", limit: int = 8):
    """Picker search for the preview modal: substring match over title,
    artists, album (case-insensitive). Bounded, no ranking - a picker, not
    the search page."""
    q = q.strip()
    if not q:
        return {"tracks": []}
    limit = max(1, min(limit, 25))
    like = f"%{q.lower()}%"
    db = SessionLocal()
    try:
        rows = db.query(Track).filter(
            func.lower(Track.name).like(like),
        ).union(
            db.query(Track).filter(func.lower(Track.artists).like(like)),
        ).union(
            db.query(Track).filter(
                Track.album_name.isnot(None),
                func.lower(Track.album_name).like(like)),
        ).limit(limit).all()
        return {"tracks": [_track_out(t) for t in rows]}
    finally:
        db.close()


@router.get("/random-tracks")
def random_tracks(limit: int = 20):
    """Random sample of tracks for the preview modal (ORDER BY RANDOM())."""
    limit = max(1, min(limit, PREVIEW_MAX_TRACKS))
    db = SessionLocal()
    try:
        rows = db.query(Track).order_by(func.random()).limit(limit).all()
        return {"tracks": [_track_out(t) for t in rows]}
    finally:
        db.close()
