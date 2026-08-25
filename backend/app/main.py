import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import init_db
from .api import api_router
from .spotify import credentials

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not credentials.configured():
        logger.warning(
            "Spotify credentials not configured (no credentials file at %s); "
            "OAuth unavailable until set via POST /api/spotify/credentials.",
            credentials.creds_path(),
        )
    init_db()
    yield


app = FastAPI(title="Spotify Tracker", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "spotify-tracker-api"}


@app.get("/")
async def root():
    return {"service": "spotify-tracker-api", "docs": "/api/docs"}
