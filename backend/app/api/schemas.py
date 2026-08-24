from __future__ import annotations
from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel


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
    danceability: Optional[float] = None
    energy: Optional[float] = None
    tempo: Optional[float] = None
    valence: Optional[float] = None
    acousticness: Optional[float] = None
    key: Optional[int] = None
    time_signature: Optional[int] = None
    is_latin_american: bool = False
    is_mexican: bool = False
    region: str = ""
    language: str = ""
    genres: Any = []
    classification_strategy: str = ""
    run_id: Optional[int] = None

    model_config = {"from_attributes": True}


class ClassificationRunOut(BaseModel):
    id: int
    name: str
    strategy: str = "hybrid"
    status: str = "pending"
    created_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    llm_used: bool = False
    n_classified: int = 0
    n_mexican: int = 0
    n_latin_american: int = 0

    model_config = {"from_attributes": True}


class SearchQuery(BaseModel):
    """Structured + semantic filter request."""
    playlist_id: Optional[int] = None
    q: Optional[str] = None
    languages: list[str] = []
    regions: list[str] = []
    is_mexican: Optional[bool] = None
    is_latin_american: Optional[bool] = None
    min_energy: Optional[float] = None
    max_energy: Optional[float] = None
    min_tempo: Optional[float] = None
    max_tempo: Optional[float] = None
    min_valence: Optional[float] = None
    max_valence: Optional[float] = None
    min_danceability: Optional[float] = None
    explicit_only: Optional[bool] = None
    min_year: Optional[int] = None
    max_year: Optional[int] = None
    use_semantic: bool = True
    limit: int = 200


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
