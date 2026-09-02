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

    # The playlist other pages (Search, ...) open by default. At most one
    # playlist carries this flag (set via POST /playlists/{id}/default).
    is_default = Column(Boolean, default=False)

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
    release_date = Column(String(32), default="")
    duration_ms = Column(Integer)
    uri = Column(String(256), default="")
    external_url = Column(String(1024), default="")
    isrc = Column(String(64), index=True)

    playlist_track_index = Column(Integer, default=0)
    playlist_id = Column(Integer, ForeignKey("playlists.id"), nullable=False)

    playlist = relationship("Playlist", back_populates="tracks")

    __table_args__ = (
        Index("ix_playlist_order", "playlist_id", "playlist_track_index"),
    )


class Classifier(Base):
    """A named, versioned natural-language definition of a dynamic metadata
    field (see docs/ai-classifiers.md). Editing query/field_type bumps
    revision, which makes every stored value from an older revision stale."""

    __tablename__ = "classifiers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    query = Column(Text, nullable=False)
    field_type = Column(String(16), nullable=True)  # boolean|string|number|datetime (NULL until inferred)
    revision = Column(Integer, default=1, nullable=False)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    classifications = relationship("TrackClassification", back_populates="classifier",
                                  cascade="all, delete-orphan")


class TrackClassification(Base):
    """One current (upserted) value per (track, classifier). Staleness is
    derived: stale iff classifier_revision != classifier.revision or the
    value doesn't parse as the classifier's current field_type."""

    __tablename__ = "track_classifications"

    id = Column(Integer, primary_key=True, index=True)
    track_id = Column(Integer, ForeignKey("tracks.id"), nullable=False, index=True)
    classifier_id = Column(Integer, ForeignKey("classifiers.id"), nullable=False, index=True)
    classifier_revision = Column(Integer, nullable=False)
    value = Column(Text, nullable=False)  # JSON: true | 3.5 | "x" | "2024-01-01T00:00:00Z"
    reason = Column(Text, default="")
    classified_at = Column(DateTime, default=utcnow)

    track = relationship("Track")
    classifier = relationship("Classifier", back_populates="classifications")

    __table_args__ = (
        Index("uq_track_classifier", "track_id", "classifier_id", unique=True),
        Index("ix_tc_classifier_revision", "classifier_id", "classifier_revision"),
    )


class ClassifierJob(Base):
    """One background classification pass over a (classifier, playlist) scope.
    Created by the job manager's auto-scan (or manually) and stepped by the
    manager thread until no work remains. Classification is an upsert keyed on
    (track, classifier, revision), so a job is always resumable: interrupted
    work simply still "needs work" on the next step. See docs/ai-classifiers.md."""

    __tablename__ = "classifier_jobs"

    id = Column(Integer, primary_key=True, index=True)
    classifier_id = Column(Integer, ForeignKey("classifiers.id"), nullable=False, index=True)
    playlist_id = Column(Integer, ForeignKey("playlists.id"), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="queued")
    # queued | running | cancelling | done | error | cancelled
    total = Column(Integer, default=0, nullable=False)   # tracks needing work at enqueue
    done = Column(Integer, default=0, nullable=False)     # classified so far
    failed = Column(Integer, default=0, nullable=False)   # bad rows so far (retried later)
    attempts = Column(Integer, default=0, nullable=False)
    error = Column(Text, default="")
    retry_after = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    classifier = relationship("Classifier")
    playlist = relationship("Playlist")

    __table_args__ = (
        Index("ix_cj_scope_status", "classifier_id", "playlist_id", "status"),
    )


class GeneratedPlaylist(Base):
    __tablename__ = "generated_playlists"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, default="")
    source_playlist_id = Column(Integer, ForeignKey("playlists.id"), nullable=False)
    search_spec = Column(Text, default="{}")
    preview_mode = Column(Boolean, default=True)
    sync_mode = Column(String(16), default="once")
    spotify_playlist_id = Column(String(64), nullable=True)
    spotify_external_url = Column(String(1024), default="")
    last_synced_uris = Column(Text, default="[]")
    last_synced_at = Column(DateTime, nullable=True)
    last_sync_status = Column(String(512), default="")
    created_at = Column(DateTime, default=utcnow)

    source_playlist = relationship("Playlist")

