# ============================================================================
# Spotify Tracker - multi-stage Dockerfile
#
#   docker compose build api        -> target backend
#   docker compose build frontend   -> target frontend
#   docker compose up --build       -> both
# ============================================================================
# syntax=docker/dockerfile:1

# ---- Base: Python with backend deps ----
FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WORKER_CONCURRENCY=4
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./backend

# ---- Target: backend API server ----
FROM base AS backend
EXPOSE 8000
RUN mkdir -p /data
ENV DATABASE_URL="sqlite:////data/spotify_tracker.db"
WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ---- Stage: build the React SPA ----
FROM node:20-bookworm AS frontend-build
WORKDIR /build
COPY docker/frontend/package.json docker/frontend/package-lock.json* ./
RUN npm install --ignore-scripts
COPY docker/frontend/ ./
RUN npm run build

# ---- Target: nginx serving the SPA + proxying /api ----
FROM nginx:1.27-alpine AS frontend
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /build/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]