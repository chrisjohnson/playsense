from __future__ import annotations
import json
import math
from sqlalchemy import func
from sqlalchemy import and_ as sa_and
from ..db import SessionLocal
from ..models import Track, Playlist, ClassificationRun
from .schemas import SearchQuery


def _year(tracks):
    out = []
    for t in tracks:
        d = (t.release_date or "")[:4]
        out.append(int(d) if d.isdigit() else None)
    return out


def query_tracks(q: SearchQuery) -> list:
    """Apply all structured filters (Spotify does not expose these combinations)."""
    db = SessionLocal()
    try:
        stmt = db.query(Track)
        if q.playlist_id is not None:
            stmt = stmt.filter(Track.playlist_id == q.playlist_id)
        if q.is_mexican is not None:
            stmt = stmt.filter(Track.is_mexican == q.is_mexican)
        if q.is_latin_american is not None:
            stmt = stmt.filter(Track.is_latin_american == q.is_latin_american)
        if q.languages:
            stmt = stmt.filter(Track.language.in_(q.languages))
        if q.regions:
            stmt = stmt.filter(Track.region.in_(q.regions))
        if q.min_energy is not None:
            stmt = stmt.filter(Track.energy >= q.min_energy)
        if q.max_energy is not None:
            stmt = stmt.filter(Track.energy <= q.max_energy)
        if q.min_tempo is not None:
            stmt = stmt.filter(Track.tempo >= q.min_tempo)
        if q.max_tempo is not None:
            stmt = stmt.filter(Track.tempo <= q.max_tempo)
        if q.min_valence is not None:
            stmt = stmt.filter(Track.valence >= q.min_valence)
        if q.max_valence is not None:
            stmt = stmt.filter(Track.valence <= q.max_valence)
        if q.min_danceability is not None:
            stmt = stmt.filter(Track.danceability >= q.min_danceability)
        if q.min_year is not None:
            stmt = stmt.filter(func.coalesce(Track.release_date, "").like(f"{q.min_year}%"))
        if q.max_year is not None:
            stmt = stmt.filter(func.coalesce(Track.release_date, "").like(f"{q.max_year}%"))
        if q.max_tempo is not None:
            stmt = stmt.filter(Track.tempo <= q.max_tempo)
        stmt = stmt.order_by(Track.playlist_id, Track.playlist_track_index)
        items = stmt.limit(q.limit).all()
        return items
    finally:
        db.close()


def build_playlist_from_query(q: SearchQuery) -> list[dict]:
    """Structured search; if a free-text query is given, fall through to semantic enrichment."""
    db = SessionLocal()
    try:
        from ..inference.engine import ClassificationEngine
        tracks = query_tracks(q)
        out = []
        if q.q and q.use_semantic:
            engine = ClassificationEngine()
            for t in tracks:
                fields = _track_fields(t)
                res = engine.classify(
                    [a["name"] for a in fields["artists"]],
                    fields["album"], fields["title"], fields["year"], fields["genres"],
                    use_semantic=True)
                if res.is_mexican or res.is_latin_american:
                    t.is_mexican = res.is_mexican
                    t.is_latin_american = res.is_latin_american
                    t.region = res.region
                    t.language = res.language
        if q.q and q.use_semantic:
            tracks = [t for t in tracks if (t.is_mexican or t.is_latin_american)]

        for t in tracks:
            fields = _track_fields(t)
            out.append({
                "spotify_track_id": t.spotify_track_id,
                "name": t.name,
                "artists": fields["artists"],
                "album_name": t.album_name,
                "release_date": t.release_date,
                "duration_ms": t.duration_ms,
                "uri": t.uri,
                "external_url": t.external_url,
                "is_mexican": t.is_mexican,
                "is_latin_american": t.is_latin_american,
                "region": t.region,
                "language": t.language,
                "genres": _as_list(t.genres),
                "classification_strategy": t.classification_strategy,
            })
        return out
    finally:
        db.close()


def _track_fields(t) -> dict:
    return {
        "artists": json.loads(t.artists or "[]"),
        "album": t.album_name or "",
        "title": t.name or "",
        "year": (t.release_date or "")[:4],
        "genres": _as_list(t.genres),
    }


def _as_list(v) -> list:
    if isinstance(v, str):
        if not v:
            return []
        return [x.strip() for x in v.split(",") if x.strip()]
    return list(v or [])
