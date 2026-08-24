# Spotify Tracker

A self-hosted app for connecting to your Spotify account, downloading named
playlists with full track metadata, searching/filtering them (Latin American /
Mexican music by artist origin and subgenre), and generating new playlists
from filtered results — optionally pushed back to your account.

Classification is hybrid: fast structured / keyword filters run first, and an
LLM (OpenAI-compatible endpoint — Ollama, vLLM, LM Studio, ...) is used only as
a confidence-scoring fallback for ambiguous cases.

## Contents

- **backend** — Python / FastAPI + SQLAlchemy + SQLite + httpx REST API
- **docker/frontend** — React 18 + MUI + Vite single-page app
- **nginx** (in the frontend image) serves the SPA and proxies /api/ to the backend

## Architecture

Browser -> frontend (nginx:80)
                  | proxies /api/ -> api (uvicorn:8000) -> SQLite DB (/data)

   api -> Spotify API (OAuth2 + PKCE)
   api -> Inference backend  (OpenAI-compatible, e.g. http://host.docker.internal:11434/v1)

## Quick start (Docker Compose)

Prerequisites: Docker with the docker compose plugin (or docker-compose).

1. Configure credentials (see .env.example):
     cp .env.example .env
   then edit .env: set SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (and SECRET_KEY).

2. Build & start everything:
     docker compose up --build

3. Open the app in your browser:
     http://localhost:3000

The frontend container is nginx. It serves the built SPA on port 3000 and
proxies every /api/* request to the api container. The API listens on 8000
internally (not exposed to the host directly).

### Default environment values

- SPOTIFY_CLIENT_ID       — empty by default (set it)
- SPOTIFY_CLIENT_SECRET   — empty by default (set it)
- APP_PUBLIC_URL          — http://localhost:8000
- SPOTIFY_REDIRECT_URI    — http://localhost:8000/api/oauth/redirect (match Spotify dashboard)
- SPOTIFY_SCOPES          — user-read-private,user-read-email,playlist-read-private,playlist-read-collaborative,playlist-modify-public,playlist-modify-private
- DATABASE_URL            — sqlite:////data/spotify_tracker.db
- INFERENCE_BASE_URL      — http://host.docker.internal:11434/v1
- INFERENCE_API_KEY       — sk-not-needed-for-ollama (only for hosted providers)
- INFERENCE_MODEL         — llama3.1:8b
- INFERENCE_TIMEOUT_SECONDS — 60
- SEMANTIC_CONFIDENCE_THRESHOLD — 0.85 (structured result accepted without LLM at/above this)
- SECRET_KEY              — change-me-to-a-random-string

## First-time setup

1. Create a Spotify app at https://developer.spotify.com/dashboard. Copy the
   Client ID and Client Secret into .env.
2. Set the app's Redirect URI to http://localhost:8000/api/oauth/redirect
   (matching SPOTIFY_REDIRECT_URI).
3. Start the stack: docker compose up --build
4. In the app, click Home -> Connect to Spotify. You'll be redirected to
   Spotify, asked to authorize, and sent back to /api/oauth/redirect.
5. The status chip turns green (Connected) once authenticated.

Push-back (generating playlists on your account) requests the
playlist-modify-public, playlist-modify-private scopes. Grant them at auth time
to use "Push to Spotify".

## How to use the app

- Home — connect your account and download named playlists (tracks + metadata).
- Tracks — browse the tracks stored for each playlist.
- Search — filter tracks by region (is_mexican / is_latin_american), language,
  genre, and keyword. Classifications are re-run on demand.
- Generate — run a filter, preview the matched tracks, then export to JSON or
  push the playlist back to your Spotify account.
- Runs — history of classification jobs (strategy used, counts, timestamps).

## Classification model (how music is tagged)

The engine is Spanish-first and then drills into Mexican regional subgenres:

1. Gate on language — a Spanish signal (title/artist/genre in Spanish, or the
   language field) is required to be tagged as Mexican / Latin American.
2. Mexican regional subgenres — detection of nordeno, mariachi, son jarocho,
   banda, grupero, durangero, huapango, sierenyo, etc.
3. LLM fallback — when keyword confidence is below SEMANTIC_CONFIDENCE_THRESHOLD,
   the request is sent to the OpenAI-compatible inference backend, which returns:

   { "is_mexican": true, "is_latin_american": true, "region": "Mexico",
     "language": "es", "confidence": 0.94,
     "reasoning": "nordeno harmonics + accordion; Los Tigres del Norte",
     "signal": ["nordeno", "accordion", "Tigres"] }

If no inference backend is configured (or unreachable), classification falls back
to the deterministic keyword/structured path.

## Docker usage (without compose)

If you don't have docker compose, build and run the two images directly. The
database persists in the local ./data directory.

docker build --target backend  -t spotify-tracker:backend .
docker build --target frontend -t spotify-tracker:frontend .

# Run the API. host-gateway lets it reach a host-side inference backend.
docker run -d --name api --add-host host.docker.internal:host-gateway \
  -p 8000:8000 -v "$PWD/data:/data" \
  -e DATABASE_URL="sqlite:////data/spotify_tracker.db" \
  -e INFERENCE_BASE_URL="http://host.docker.internal:11434/v1" \
  spotify-tracker:backend

# Run the frontend (nginx). It proxies /api/ to the api container.
docker run -d --name sp-tracker-frontend -p 3000:80 spotify-tracker:frontend

Then open http://localhost:3000.

## Local development

### Backend (FastAPI)

cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DATABASE_URL="sqlite:////tmp/spotify_tracker.db"
export INFERENCE_BASE_URL="http://host.docker.internal:11434/v1"
export SECRET_KEY="dev-secret"

API at http://localhost:8000 — interactive docs at http://localhost:8000/docs
uvicorn app.main:app --reload

### Frontend (Vite + React)

cd docker/frontend
npm install
npm run dev          # http://localhost:5173 (proxies /api to the API container)
npm run build        # production bundle -> dist/

## API endpoints

- GET    /api/health                     — Liveness check
- GET    /api/auth/status                — Whether a user is authenticated
- GET    /api/oauth/authorize            — Returns an OAuth authorize URL + state
- GET    /api/oauth/redirect             — Callback: exchanges the code, fetches /me
- GET    /api/playlists                  — List playlists (with track counts)
- POST   /api/playlists/{pl_id}/download — Download a named Spotify playlist
- POST   /api/playlists/{pl_id}/classify — Run classification on a playlist
- GET    /api/playlists/{pl_id}/tracks    — List tracks for a playlist
- POST   /api/search                     — Filter tracks (returns matches)
- POST   /api/generate                   — Filter + export JSON or push to Spotify
- GET    /api/runs                       — Classification run history

### POST /api/search example

   { "playlist_id": 1, "is_mexican": true, "use_semantic": false }

### POST /api/generate example

   { "name": "Mexican Favorites", "description": "Mexican regional picks",
     "push_to_spotify": true,
     "search": { "playlist_id": 1, "is_mexican": true, "use_semantic": false } }

## Troubleshooting

- "Not connected" after auth — make sure SPOTIFY_REDIRECT_URI matches the
  Redirect URI in the Spotify dashboard exactly.
- Inference unreachable — if the backend can't reach your model at
  INFERENCE_BASE_URL, classification still works via the keyword path (it just
  won't set classification_strategy = "llm").
- DB empty after restart — the database lives in ./data/spotify_tracker.db
  (bind-mounted to the api container). Deleting that file resets all data.
- docker compose unavailable — build/run the images directly as shown above;
  the compose file uses the same build targets.

## Project layout

.
├── Dockerfile                     # multi-stage: backend + frontend-build + nginx
├── docker-compose.yml             # api + frontend services
├── .env.example
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py                # FastAPI app, mounts router
│       ├── db.py / models.py      # SQLAlchemy session + ORM models
│       ├── config.py              # env-driven settings
│       ├── api/                   # router, schemas, search
│       ├── spotify/               # OAuth client, download
│       └── inference/             # engine (keyword + LLM adapter + runner)
└── docker/frontend/               # React + MUI + Vite SPA
