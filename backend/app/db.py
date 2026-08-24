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
