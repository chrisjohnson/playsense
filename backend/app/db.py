from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from .config import get_settings


settings = get_settings()
connect_kwargs: dict = {"future": True}
if settings.database_url.startswith("sqlite"):
    connect_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(settings.database_url, **connect_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from . import models  # noqa: F401  (ensure all models are registered on Base)
    Base.metadata.create_all(bind=engine)
    if settings.database_url.startswith("sqlite"):
        # create_all never ALTERs existing tables - add new columns manually.
        from sqlalchemy import inspect, text
        with engine.connect() as conn:
            cols = {c["name"] for c in inspect(conn).get_columns("playlists")}
            if "is_default" not in cols:
                conn.execute(text("ALTER TABLE playlists ADD COLUMN is_default BOOLEAN DEFAULT 0"))
                conn.commit()
            tcols = {c["name"] for c in inspect(conn).get_columns("tracks")}
            for col, decl in (("explicit", "BOOLEAN"), ("disc_number", "INTEGER"),
                              ("track_number", "INTEGER"), ("album_type", "VARCHAR(16)"),
                              ("release_date_precision", "VARCHAR(8)"),
                              ("album_images", "TEXT"), ("album_artists", "TEXT")):
                if col not in tcols:
                    conn.execute(text(f"ALTER TABLE tracks ADD COLUMN {col} {decl}"))
            conn.commit()
