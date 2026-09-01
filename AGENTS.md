# AGENTS.md - Spotify Tracker

Notes for agents working in this repo. Read before editing.

## 0. Workspace / sandbox caveat

You run inside a container. The project path you see as /home/node/spotify-tracker
may be translated on the host to a different directory ($HOST_WORK_DIR).
Verify things by inspecting the container / host directly - never assume a path.
- docker / docker compose spawn sibling containers on the host daemon.
- Bind mounts (-v <src>:/data) resolve <src> on the HOST filesystem, not your
  container's view. If you must create/delete files on a mounted host path, do it
  via a container that mounts that same path (e.g. docker run --rm -v <src>:/data ...),
  not via your own shell rm/ls, which may target a different host directory.

## 1. Track changes with git (required)

- Every meaningful change -> a git commit. No silent edits.
- After staging: run git status to review, then git commit -m "<imperative summary>".
- Commit messages: short imperative summary on line 1, blank line, optional body
  explaining why (especially for bug fixes). Reference the symptom for fixes,
  e.g. "fix inference: flag failed semantic call as semantic_unavailable".
- git status should be clean when you finish a task. Report the commit hash.
- Do NOT commit: data/*.db, .env, __pycache__/, node_modules/, dist/, logs.
  These are in .gitignore; verify with git status --ignored if unsure.
- If you changed the Dockerfile or anything under backend/, REBUILD the image
  (backend source is COPY-ed into the image at build time):
  docker build --target backend -t spotify-tracker:backend .
  Then recreate the api container and re-verify (see section 3).

## 2. Architecture (quick map)

- Backend (FastAPI): backend/app/
  - api/: router.py (POST /api/search, POST /api/generate,
    POST /api/playlists/{id}/classify, GET /api/playlists/{id}/tracks,
    POST /api/runs), search.py, schemas.py
  - inference/: engine.py (hybrid classification), adapter.py (OpenAI-compatible
    HTTP call). The engine MUST surface a FAILED semantic call as
    strategy="semantic_unavailable" (never a false confident "llm" verdict).
  - spotify/: OAuth + download.
- Frontend (React): docker/frontend/ (built to dist/, served by nginx).
- Compose: api (:8000) + frontend (:3000). DB at ./data/spotify_tracker.db.

## 3. Test / verify changes

Never ship a change without verifying. Prefer the running container.

- Service health: curl -s http://localhost:8000/api/health -> {"status":"ok"}.
- Frontend: curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ -> 200 (SPA).
- Endpoints use their real HTTP method. Search and generate are POST, not GET
  (POST /api/search, POST /api/generate). A 405/404 on these is usually a caller
  mistake, not an app bug.
- Seed + classify + probe (the canonical verification loop):
  1. Seed a fixture:
     docker cp /tmp/live_seed.py api:/seed.py && docker exec api sh -c 'cd /app/backend && PYTHONPATH=/app/backend python3 /seed.py'
  2. Classify:
     curl -s -X POST http://localhost:8000/api/playlists/1/classify -H 'Content-Type: application/json' -d '{"name":"Verification","use_semantic":true}'
     -> check llm_used is false when no LLM endpoint is reachable, and counts look sane.
  3. Per-track strategy:
     docker cp /tmp/probe_tracks.py api:/probe.py && docker exec api sh -c 'cd /app/backend && PYTHONPATH=/app/backend python3 /probe.py'
     -> an ambiguous track with no keyword signal must NOT read strategy=llm with a
     confident Latin/non-Latin label; it should read semantic_unavailable.
- Rebuild first if you changed Dockerfile or anything under backend/. Then recreate
  the api container (preserve env: DATABASE_URL, WORKER_CONCURRENCY, INFERENCE_BASE_URL,
  extra-hosts, network, volume bind).
- After verification, reset the DB to pristine for handoff: stop api, delete
  data/spotify_tracker.db from the REAL host path (via a container that mounts it),
  restart.

## 4. Environmental constraints (known)

- No local LLM endpoint is reachable by default (Ollama on host.docker.internal:11434
  is often absent). The semantic/LLM path is UNTESTABLE here - only the structured and
  keyword heuristic paths are. Make sure code degrades gracefully when inference fails.

## 5. Spotify API / quota reality (post-Feb+Jul 2026 dev-mode changes)

The app runs as a DEVELOPMENT-MODE app; these limits are hard and not published in
full. Design around them, do not fight them:

- **Quota is per DEVELOPER ACCOUNT** (since Jul 2026). Multiple Client IDs share one
  quota pool - creating a new app does NOT get you a fresh budget.
- **429 has two kinds** (body: `{"error":{"status":429,"reason":...}}`):
  - `reason: QUOTA_EXCEEDED` - the account's quota budget is gone. Waiting seconds
    helps nothing; the window resets on a long (typically ~daily) schedule. The
    download worker (`backend/app/spotify/worker.py`) pauses and probes later.
  - Otherwise - rolling 30s rate limit. `client.py`'s Pacer paces requests
    (default 8/30s, degrades on 429, recovers when clean) and retries with
    Retry-After.
- **Feb 2026 endpoint changes (dev mode)**:
  - Batch endpoints are GONE: `/tracks?ids=`, `/albums?ids=`, `/artists?ids=`,
    `/audio-features?ids=`, etc. Fetch individually (the download worker skips
    audio features entirely).
  - Playlist items: `GET /playlists/{id}/tracks` (NEW; page limit max **50**,
    was 100) - but it **403s for dev-mode apps**; the legacy `/items` endpoint
    still works and still accepts **limit=100**. download.py probes new-first,
    falls back to legacy (treat 403/404/405/410 on the probe as unavailable).
  - **Response field renames:** playlist entries carry the track object under
    `items[].item` (the old `items[].track` key comes back **null**). Code must
    read `entry.get("track") or entry.get("item")`. `popularity` field removed.
  - Search `limit` max dropped 50 -> 10. `/me` no longer returns email/country.
    Other users' playlists/profiles: metadata only.
  - Dev mode requires the app owner to have Premium; <=5 authorized users per app.
- **Downloads are background work**: POST /playlists/{id}/download ENQUEUES; the
  worker grinds page-by-page, commits per page, and progress (download_* columns
  on playlists) survives container restarts. A 5000-track playlist needs ~100
  page requests - that can legitimately span multiple quota windows. NEVER make
  the download endpoint synchronous for large playlists.
- The DB (data/spotify_tracker.db) holds the OAuth tokens AND download progress.
  The api container MUST keep the host bind mount on /data (host path:
  $HOST_WORK_DIR equivalent of this repo's data/ - see the container's mounts,
  `docker inspect api`); the old failure mode was running api without it, losing
  tokens+progress when the container was recreated. Refresh tokens also expire
  after ~6 months: user must click Connect again.
