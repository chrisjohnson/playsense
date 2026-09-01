from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Boolean, Float, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import relationship
from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    spotify_id = Column(String(64), unique=True, index=True, nullable=False)
    display_name = Column(String(255), default="")
    email = Column(String(255), default="")
    access_token = Column(String(512), nullable=False)
    refresh_token = Column(String(512), nullable=False)
    token_expires_at = Column(DateTime, nullable=True)

    playlists = relationship("Playlist", back_populates="user", cascade="all, delete-orphan")


class Playlist(Base):
    __tablename__ = "playlists"

    id = Column(Integer, primary_key=True, index=True)
    spotify_playlist_id = Column(String(64), unique=True, index=True, nullable=False)
    name = Column(String(512), nullable=False)
    description = Column(Text, default="")
    images = Column(Text, default="")
    owner_id = Column(String(64), index=True)
    external_url = Column(String(1024), default="")
    is_public = Column(Boolean, default=False)
    fetched_at = Column(DateTime, default=utcnow)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    # Background download progress (the worker grinds across quota windows)
    download_state = Column(String(32), default="idle")  # idle|queued|downloading|waiting_quota|done|error
    download_saved = Column(Integer, default=0)
    download_total = Column(Integer, default=0)
    download_error = Column(String(1024), default="")
    download_updated_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="playlists")
    tracks = relationship("Track", back_populates="playlist", cascade="all, delete-orphan")


class Track(Base):
    __tablename__ = "tracks"

    id = Column(Integer, primary_key=True, index=True)
    spotify_track_id = Column(String(64), unique=True, index=True, nullable=False)
    name = Column(String(512), nullable=False)
    artists = Column(Text, default="")
    album_name = Column(String(512), default="")
    album_id = Column(String(64), index=True)
    album_artist = Column(Text, default="")
    release_date = Column(String(32), default="")
    duration_ms = Column(Integer)
    uri = Column(String(256), default="")
    external_url = Column(String(1024), default="")
    isrc = Column(String(64), index=True)

    danceability = Column(Float)
    energy = Column(Float)
    key = Column(Integer)
    mode = Column(Integer)
    loudness = Column(Float)
    tempo = Column(Float)
    time_signature = Column(Integer)
    acousticness = Column(Float)
    instrumentalness = Column(Float)
    liveness = Column(Float)
    speechiness = Column(Float)
    valence = Column(Float)

    is_latin_american = Column(Boolean, index=True, default=False)
    is_mexican = Column(Boolean, index=True, default=False)
    region = Column(String(128), default="")
    language = Column(String(64), default="")
    genres = Column(Text, default="")
    classification_strategy = Column(String(32), default="")

    playlist_track_index = Column(Integer, default=0)
    playlist_id = Column(Integer, ForeignKey("playlists.id"), nullable=False)
    run_id = Column(Integer, ForeignKey("classification_runs.id"), nullable=True)

    playlist = relationship("Playlist", back_populates="tracks")
    run = relationship("ClassificationRun", back_populates="tracks")

    __table_args__ = (
        Index("ix_playlist_order", "playlist_id", "playlist_track_index"),
    )


class ClassificationRun(Base):
    __tablename__ = "classification_runs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    strategy = Column(String(64), default="hybrid")
    status = Column(String(32), default="pending")
    created_at = Column(DateTime, default=utcnow)
    finished_at = Column(DateTime, nullable=True)
    llm_used = Column(Boolean, default=False)
    n_classified = Column(Integer, default=0)
    n_mexican = Column(Integer, default=0)
    n_latin_american = Column(Integer, default=0)
    prompt = Column(Text, default="")

    tracks = relationship("Track", back_populates="run")
