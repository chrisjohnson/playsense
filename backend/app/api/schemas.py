from __future__ import annotations
from datetime import datetime
from typing import Any, Optional
import json as _json
from pydantic import BaseModel, field_validator


class PlaylistOut(BaseModel):
    id: int
    spotify_playlist_id: str
    name: str
    description: str = ""
    owner_id: str = ""
    is_public: bool = False
    external_url: str = ""
    fetched_at: Optional[datetime] = None
    track_count: int = 0
    is_default: bool = False

    model_config = {"from_attributes": True}


class TrackOut(BaseModel):
    id: int
    spotify_track_id: str
    name: str
    artists: Any = []
    album_name: str = ""
    release_date: str = ""
    duration_ms: Optional[int] = None
    uri: str = ""
    external_url: str = ""
    # AI-classifier values: {"<classifier_id>": {"value": <json>, "stale": bool, "reason": str}}
    classifications: dict = {}

    model_config = {"from_attributes": True}

    @field_validator("artists", mode="before")
    @classmethod
    def _parse_json_lists(cls, v):
        # artists is stored as JSON text on the model; the API must
        # return it as an array (the frontend .map()s over it).
        if isinstance(v, str):
            try:
                return _json.loads(v) or []
            except _json.JSONDecodeError:
                return []
        return v or []


class SearchQuery(BaseModel):
    """Traditional metadata filters + optional semantic (LLM) free-text.

    The metadata filters (title/artist/album/year) are plain
    structured search - instant, no LLM. `q` is the semantic part: the query
    plus each track's metadata goes to the LLM, so free-text like
    "mariachi music" or "mexican and mexican-inspired" works. Audio-feature
    filters were removed earlier (dev mode never returns audio features).
    """
    playlist_id: Optional[int] = None
    q: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None
    album: Optional[str] = None
    min_year: Optional[int] = None
    max_year: Optional[int] = None
    use_semantic: bool = True
    limit: int = 500
    # AI-classifier filters: {"<classifier_id>": <expected value>}
    # boolean: true/false (exact) | string: contains | number/datetime: exact
    classifier_filters: Optional[dict] = None


class GeneratePlaylistIn(BaseModel):
    name: str
    description: str = ""
    search: SearchQuery = SearchQuery()
    push_to_spotify: bool = True


class GeneratePlaylistOut(BaseModel):
    matched_count: int
    export_path: Optional[str] = None
    spotify_playlist_id: Optional[str] = None
    spotify_external_url: Optional[str] = None
    push_error: Optional[str] = None
