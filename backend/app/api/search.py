from __future__ import annotations
import json
import re
from sqlalchemy import func, and_
from sqlalchemy.orm import aliased
from ..db import SessionLocal
from ..models import Track, Classifier, TrackClassification
from ..inference.adapter import InferenceAdapter
from .schemas import SearchQuery

# Semantic search is one LLM call per batch; keep prompts small and bounded.
SEMANTIC_BATCH = 25
SEMANTIC_MAX_CANDIDATES = 200


def _slim(t: Track) -> dict:
    return {
        "id": t.id,
        "title": t.name or "",
        "artists": [a.get("name", "") for a in json.loads(t.artists or "[]")],
        "album": t.album_name or "",
        "year": (t.release_date or "")[:4],
    }


def _as_list(v) -> list:
    if isinstance(v, str):
        return [x.strip() for x in v.split(",") if x.strip()]
    return list(v or [])


def _to_out(t: Track, reason: str = "", classifications: dict | None = None) -> dict:
    return {
        "id": t.id,
        "spotify_track_id": t.spotify_track_id,
        "name": t.name or "",
        "artists": json.loads(t.artists or "[]"),
        "album_name": t.album_name or "",
        "release_date": t.release_date or "",
        "duration_ms": t.duration_ms,
        "uri": t.uri or "",
        "external_url": t.external_url or "",
        "match_reason": reason,
        "classifications": classifications or {},
    }


def classifications_map(db, track_ids) -> dict:
    """{track_id: {classifier_id_str: {value, stale, reason}}} for the given ids."""
    if not track_ids:
        return {}
    cls_rows = db.query(Classifier).all()
    if not cls_rows:
        return {}
    rev = {c.id: c.revision for c in cls_rows}
    out: dict = {}
    rows = (db.query(TrackClassification)
            .filter(TrackClassification.track_id.in_(track_ids))
            .filter(TrackClassification.classifier_id.in_([c.id for c in cls_rows])).all())
    for r in rows:
        try:
            v = json.loads(r.value)
        except (json.JSONDecodeError, TypeError):
            v = None
        out.setdefault(r.track_id, {})[str(r.classifier_id)] = {
            "value": v, "stale": r.classifier_revision != rev.get(r.classifier_id),
            "reason": r.reason or "",
        }
    return out


def _keyword_score(query: str, s: dict) -> float:
    """Fraction of query tokens found in title/artists/album. Fallback used
    when the LLM endpoint is unreachable or when use_semantic is off."""
    tokens = [tok for tok in re.split(r"\W+", query.lower()) if len(tok) >= 2]
    if not tokens:
        return 1.0
    hay = f"{s['title']} {' '.join(s['artists'])} {s['album']}".lower()
    return sum(1 for tok in tokens if tok in hay) / len(tokens)


def run_search(q: SearchQuery) -> dict:
    """Structured filters + optional semantic (LLM) free-text relevance.

    Returns {"total", "count", "semantic", "query", "tracks"} where
    semantic is "off" (no query), "llm" (relevance judged by the LLM) or
    "keyword" (token-match fallback — also reported when the LLM was
    requested but unavailable).
    """
    db = SessionLocal()
    try:
        scope = db.query(Track)
        if q.playlist_id is not None:
            scope = scope.filter(Track.playlist_id == q.playlist_id)
        total = scope.count()

        # Traditional metadata filters - plain SQL, no LLM involved.
        stmt = scope
        title = (q.title or "").strip()
        artist = (q.artist or "").strip()
        album = (q.album or "").strip()
        if title:
            stmt = stmt.filter(Track.name.ilike(f"%{title}%"))
        if artist:
            # artists is a JSON array of {id, name, uri}; contains-match on
            # the raw text covers artist-name filtering well enough.
            stmt = stmt.filter(Track.artists.ilike(f"%{artist}%"))
        if album:
            stmt = stmt.filter(Track.album_name.ilike(f"%{album}%"))
        if q.min_year is not None:
            stmt = stmt.filter(func.substr(Track.release_date, 1, 4) >= f"{q.min_year:04d}")
        if q.max_year is not None:
            stmt = stmt.filter(func.substr(Track.release_date, 1, 4) <= f"{q.max_year:04d}")
        # AI-classifier filters: join the pre-computed values (instant, no LLM)
        for cid_raw, val in (q.classifier_filters or {}).items():
            try:
                cid = int(cid_raw)
            except (TypeError, ValueError):
                continue
            cls = db.get(Classifier, cid)
            if cls is None:
                continue
            alias = aliased(TrackClassification)
            cond = (and_(alias.track_id == Track.id,
                         alias.classifier_id == cls.id,
                         alias.classifier_revision == cls.revision))
            if isinstance(val, bool) or (isinstance(val, (int, float)) and not isinstance(val, bool)):
                cond = and_(cond, alias.value == json.dumps(val))  # boolean/number: exact
            else:
                cond = and_(cond, alias.value.ilike(f"%{val}%"))  # string: contains
            stmt = stmt.join(alias, cond)
        candidates = stmt.order_by(Track.playlist_id, Track.playlist_track_index).all()

        query = (q.q or "").strip()
        if not query:
            rows = [_to_out(t) for t in candidates[: q.limit]]
            cmaps = classifications_map(db, [r["id"] for r in rows])
            for r in rows:
                r["classifications"] = cmaps.get(r["id"], {})
            return {"total": total, "count": len(rows), "semantic": "off",
                    "query": "", "tracks": rows}

        scored: list = []  # (score, track, reason)
        mode = "keyword"

        # Stage 1 (recall): keyword pre-filter over ALL candidates, so a hit
        # late in a 5000-track playlist is not missed. Stage 2 (precision):
        # the LLM re-scores the top hits (bounded by SEMANTIC_MAX_CANDIDATES).
        kw = [(s, t) for s, t in ((_keyword_score(query, _slim(t)), t) for t in candidates) if s > 0]
        kw.sort(key=lambda x: (-x[0], x[1].playlist_id, x[1].playlist_track_index))

        if q.use_semantic:
            # kw holds (score, track) pairs; pool needs plain Track objects.
            pool = ([t for _, t in kw] or candidates)[:SEMANTIC_MAX_CANDIDATES]
            try:
                llm = InferenceAdapter()
                for i in range(0, len(pool), SEMANTIC_BATCH):
                    batch = pool[i:i + SEMANTIC_BATCH]
                    res = llm.relevance_batch(query, [_slim(t) for t in batch])
                    for t in batch:
                        r = res.get(t.id)
                        if r:
                            scored.append((r["score"], t, r["reason"]))
                mode = "llm"
            except Exception:
                mode = "keyword"
                scored = []
        if mode == "keyword":
            scored = [(s, t, "") for (s, t) in kw]

        if mode == "llm":
            scored = [x for x in scored if x[0] >= 0.5]
        else:
            scored = [x for x in scored if x[0] > 0]
        scored.sort(key=lambda x: (-x[0], x[1].playlist_id, x[1].playlist_track_index))
        rows = [_to_out(t, reason) for (s, t, reason) in scored[: q.limit]]
        cmaps = classifications_map(db, [r["id"] for r in rows])
        for r in rows:
            r["classifications"] = cmaps.get(r["id"], {})
        return {"total": total, "count": len(rows), "semantic": mode,
                "query": query, "tracks": rows}
    finally:
        db.close()