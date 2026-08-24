from __future__ import annotations
from datetime import datetime, timezone
from ..db import SessionLocal
from ..models import Playlist, Track, ClassificationRun
from ..inference.engine import ClassificationEngine, load_track_fields


def run_classification(playlist_db_id: int, name: str, use_semantic: bool = True) -> ClassificationRun:
    db = SessionLocal()
    try:
        pl = db.get(Playlist, playlist_db_id)
        if pl is None:
            raise RuntimeError(f"playlist {playlist_db_id} not found")
        engine = ClassificationEngine()
        run = ClassificationRun(name=name, strategy="hybrid", status="running")
        db.add(run)
        db.commit()
        db.refresh(run)
        tracks = sorted(pl.tracks, key=lambda t: t.playlist_track_index)
        n_mex = n_lat = 0
        for t in tracks:
            fields = load_track_fields(t)
            res = engine.classify(
                [a["name"] for a in fields["artists"]],
                fields["album"], fields["title"], fields["year"], fields["genres"],
                use_semantic=use_semantic)
            t.is_mexican = res.is_mexican
            t.is_latin_american = res.is_latin_american
            t.region = res.region
            t.language = res.language
            t.classification_strategy = res.strategy
            t.run_id = run.id
            if res.is_mexican:
                n_mex += 1
            if res.is_latin_american:
                n_lat += 1
        run.finished_at = datetime.now(timezone.utc)
        run.status = "completed"
        run.llm_used = any(t.classification_strategy == "llm" for t in tracks)
        run.n_classified = len(tracks)
        run.n_mexican = n_mex
        run.n_latin_american = n_lat
        db.commit()
        result = {
            "id": run.id,
            "name": run.name,
            "strategy": run.strategy,
            "status": run.status,
            "created_at": run.created_at,
            "finished_at": run.finished_at,
            "llm_used": run.llm_used,
            "n_classified": run.n_classified,
            "n_mexican": run.n_mexican,
            "n_latin_american": run.n_latin_american,
        }
        return result
    finally:
        db.close()
