# Spotify Web API — Notes for Spotify Tracker

Concise, concrete notes for a self-hosted app that reads a user's playlists/albums/tracks and pushes saved content back. URLs cite the official Spotify for Developers documentation (developer.spotify.com).

---

## 1. OAuth2 — Authorization Code Flow with PKCE

- **Authorization endpoint:** `GET https://accounts.spotify.com/authorize`
- **Token endpoint:** `POST https://accounts.spotify.com/api/token` (host is accounts.spotify.com; path is /api/token).
- **Request body must be application/x-www-form-urlencoded** with the `Content-Type` header set exactly to that value (not JSON).

**Authorization Code Flow** (server-side; client secret is safe to store) — required body params:
- `grant_type` = `authorization_code`
- `code` = the code received via redirect
- `redirect_uri` = must exactly match a registered redirect URI
- `client_id`
- `client_secret`

**Authorization Code with PKCE** (browser/mobile/desktop; no client secret):
- `grant_type` = `authorization_code`
- `code`
- `redirect_uri`
- `client_id`
- `code_verifier` (the PKCE code verifier, replacing `client_secret`)

> Auth guide: https://developer.spotify.com/documentation/web-api/concepts/authorization
> PKCE tutorial: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
> Code flow tutorial: https://developer.spotify.com/documentation/web-api/tutorials/code-flow
> Redirect URIs: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri

**Token response** (`access_token`, `token_type` = `Bearer`, `expires_in`, `scope`, and `refresh_token` on code flows):
- **Access token** is valid for **~1 hour** (`expires_in` is ~3600 seconds).
- **Refresh token has no published expiry** (does not self-expire); use `grant_type=refresh_token` to renew access tokens.
- **Refresh request** (form-encoded): `grant_type=refresh_token`, `refresh_token` (from the prior response), `client_id`.

---

## 2. Endpoints needed (read)

Base URL: `https://api.spotify.com/v1/`. Send `Authorization: Bearer <access_token>`.

| Purpose | Method + Path |
|---|---|
| A playlist | `GET /v1/playlists/{playlist_id}` |
| Playlist tracks (paginated) | `GET /v1/playlists/{playlist_id}/tracks` |
| Albums | `GET /v1/albums?ids={comma-separated}` (also `GET /v1/albums/{id}`) |
| Artists | `GET /v1/artists?ids={comma-separated}` (also `GET /v1/artists/{id}`) |
| Tracks | `GET /v1/tracks?ids={comma-separated}` (also `GET /v1/tracks/{id}`) |
| Search | `GET /v1/search?q=<query>&type=track,artist,album` |
| Current user / profile | `GET /v1/me` |
| User's playlists | `GET /v1/me/playlists` |

**Playlist tracks** returns a `PlaylistTrackPage` with pagination: `items[].track` (full track object), `items[].added_by`, `items[].added_at`, `items[].is_local`. Parameters `limit` and `offset`; `total` is the full track count.

> Reference: https://developer.spotify.com/documentation/web-api/reference/get-playlist

---

## 3. Audio Features

- **Single track:** `GET /v1/audio-features/{id}` — audio features for one track.
- **Batch:** `GET /v1/audio-features?ids={comma-separated}` — accept **up to 50 IDs** at once (track & episode IDs mixed). Returns a list aligned to the requested IDs.

**Fields returned** (normalized where noted):
- `danceability` — 0 to 1 (suitability for dancing)
- `energy` — 0 to 1 (intensity & activity)
- `key` — musical key (0 to 11)
- `mode` — mode (0 = minor, 1 = major)
- `tempo` (TEMPO) — estimated BPM
- `time_signature` — estimated meter (e.g. 4)
- `acousticness` — 0 to 1
- `instrumentalness` — 0 to 1 (higher = less vocal)
- `liveness` — 0 to 1 (likelihood of a live performance)
- `speechiness` — 0 to 1 (presence of spoken words)
- `valence` — 0 to 1 (musical positivity / mood)
- `loudness` — decibels (dB)
- `duration_ms` — track length in milliseconds
- Plus `analysis_url`, `id`, `uri`, `track_href`, `type`, `preview_url`.

**v2 preview endpoint:** Spotify ships an experimental `GET /v2/audio-features/{id}` (and batch `GET /v2/audio-features?ids=...`) preview returning the newer model's features; treat as experimental and require opt-in / preview flags.

> Concepts (audio features overview): https://developer.spotify.com/documentation/web-api/concepts/audio-features
> Reference single: https://developer.spotify.com/documentation/web-api/reference/audio-features
> Reference multiple: https://developer.spotify.com/documentation/web-api/reference/audio-features#get-multiple

---

## 4. Pagination

- **`limit`** — page size; **maximum is 100** per request.
- **`offset`** — skip N items (offset-based paging), useful for playlists/albums.
- **Cursor-based** paging via `after` / `before` (e.g. `GET /v1/me/playlists?limit=50&after={id}`) — recommended for long-running feeds because offsets drift as content changes.
- Every page is an `XxxPage` object with: `limit`, `offset`, `total` (total item count), `items[]`, `next`, `previous`, `href`, `uri`, and — for cursor paging — `cursors` (before/after).

**How to page through a large playlist:**
1. Read `total` from the first page to know how many pages you need.
2. Loop with `limit=100`, incrementing `offset` by 100 (or follow the `next` URL), until `items` is empty or you have reached `total`.
3. For live / constantly-changing lists, prefer cursor `after` paging to avoid missing or duplicating items.

> Concepts: https://developer.spotify.com/documentation/web-api/concepts/pagination

---

## 5. Rate limiting

- Spotify enforces **per-client (per-app) rate limit windows** (roughly **~600 requests/minute** in normal/extended quota; **much lower** in development mode — historically ~30 req/min). Limits are **per client ID across all users**, not per user.
- Quota tiers: **Development mode** (allowlisted, lower limit) vs **Extended quota** (allowlisted, higher limit). https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- **Response headers:**
  - `X-RateLimit` — requests used in the current window.
  - `X-RateLimit-Reset` — unix epoch seconds (ms) when the current window resets.
  - `X-RateLimit-Window` — the window length in seconds.
- On exceeding the limit you get **HTTP 429**. Best practice: **back off** — honor any `Retry-After` header; otherwise use **exponential backoff with jitter** and retry after the `X-RateLimit-Reset` time.
- Spotify does **not publish per-endpoint quotas** publicly; stay well under the ceiling and cache aggressively.

> Concepts: https://developer.spotify.com/documentation/web-api/concepts/rate-limits

---

## 6. Scopes

**Read-only scopes** needed for Spotify Tracker's reads:
- `user-read-private` — read the user's profile (username, avatar, etc.).
- `user-read-email` — read the user's email address.
- `playlist-read-private` — read **private** playlists.
- `playlist-read-collaborative` — read **collaborative** playlists.
- (Also useful: `user-read-playback-position`, `user-top-read`, `user-read-recently-played` if you surface listening history.)

**Push-back scopes** (saving to playlists via `POST /v1/playlists/{id}/tracks`):
- `playlist-modify-public` — write to **public** playlists.
- `playlist-modify-private` — write to **private** playlists.
- (Playlist modification uses these scopes — there is no separate `track-modify` scope for adding to playlists. Saving a track to the user's *library* instead uses `track-modify` / `user-library-modify` on `GET`/`POST /v1/me/tracks`.)

> Scopes overview: https://developer.spotify.com/documentation/web-api/concepts/scopes
> Playlists (confirms playlist-modify-public for public, playlist-modify-private for private): https://developer.spotify.com/documentation/web-api/concepts/playlists

---

## 7. Practical quirks

- **Token requests are form-encoded, not JSON:** `Content-Type: application/x-www-form-urlencoded`. Sending JSON to /api/token fails.
- **Status codes:** `200` OK for successful reads; `400` Bad Request for malformed/invalid params (bad scope, missing param); `401` when the token is missing/invalid; `403` for insufficient scope or quota-mode rejection; `429` when rate-limited.
- **No JSON body needed** for typical GET requests — pass query params only; the request body is empty.
- **Always send** `Authorization: Bearer <access_token>` on API calls (not on the token request itself).
- **`ids` params are comma-separated** (e.g. `?ids=3n3Ppam7vgaVa1iaRUc9Lp`, max 50 for tracks/albums/artists/audio-features; up to 100 for some endpoints such as add-tracks).
- **`state` must be validated** on the OAuth callback to prevent CSRF.

---

### Key source URLs
- Authorization concepts: https://developer.spotify.com/documentation/web-api/concepts/authorization
- Code flow tutorial: https://developer.spotify.com/documentation/web-api/tutorials/code-flow
- PKCE tutorial: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Redirect URIs: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- Scopes: https://developer.spotify.com/documentation/web-api/concepts/scopes
- Playlists (scopes for modify): https://developer.spotify.com/documentation/web-api/concepts/playlists
- Rate limits: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
- Quota modes: https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Pagination: https://developer.spotify.com/documentation/web-api/concepts/pagination
- Audio features (concepts): https://developer.spotify.com/documentation/web-api/concepts/audio-features
- Reference (endpoint-by-endpoint): https://developer.spotify.com/documentation/web-api/reference