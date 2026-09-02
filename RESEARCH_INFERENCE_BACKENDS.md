# Inference Backends & Tech Stack Research for a Self-Hosted Playlist-Classification Tracker

> Research notes for wiring playlist classification to user-hosted LLMs. Covers OpenAI-compatible
> serving backends, HTTP/JSON-mode/batching/concurrency, latency & resilience, and a recommended
> full-stack + Docker/docker-compose layout. Citations at the end.

## 0. Design principles for this app

- The app routes a *classification* prompt (playlist -> genre/mood/labels) to whichever model the
  user hosts. That means it must talk to a family of backends that all speak **the OpenAI chat
  completions protocol**, so a single client + prompt template works against Ollama, LM Studio,
  vLLM, and TGI.
- Requirements that drive the stack:
  - One client abstraction (OpenAI-compatible) over many possible base URLs (localhost, container
    names, remote GPUs).
  - Strict JSON output for classification -> use **response_format json_object** and, where
    available, **JSON-schema structured outputs** (constrained decoding).
  - Resilience: the endpoint may be a laptop Ollama, a headless server, or down entirely. Timeouts,
    bounded retries, and graceful fallback are non-negotiable.
  - Self-hosted & easy to run -> Docker Compose with optional inference proxy.

---

## 1. OpenAI-compatible server backends

All four expose the same REST surface, so the backend only needs one client. The common contract:

| Backend | Serve command | Base URL / paths | JSON mode / structured | Notes |
|---|---|---|---|---|
| Ollama | ollama serve (default http://localhost:11434) | POST /v1/chat/completions, GET /v1/models; native POST /api/generate | JSON mode via response_format, plus JSON-schema structured outputs | Great for local/dev, single-user; low concurrency |
| LM Studio | Local Server toggle | POST /v1/chat/completions, GET /v1/models | response_format json_object | Convenience desktop app; thin wrapper over GGUF/safetensors |
| vLLM | vllm serve <model> | POST /v1/chat/completions, /v1/completions, /v1/models, batch /v1/chat/completions/batch | Structured outputs on by default (--structured-output); response_format json_object | Highest throughput/concurrency; GPU, continuous batching |
| TGI | text-generation-inference (docker) | POST /v1/chat/completions (Messages API), /info, /health, /metrics | response_format json_object; JSON-schema structured outputs | HF Rust/gRPC prod engine; best for served GPU scale |

### How to hit them over HTTP

The request body is the OpenAI chat-completions schema in every case:

    POST /v1/chat/completions
    {
      "model": "llama-3.1-8b",
      "messages": [{"role": "user", "content": "Classify this playlist into JSON..."}],
      "response_format": { "type": "json_object" },
      "temperature": 0,
      "max_tokens": 256
    }

- Ollama: OpenAI-compat live at /v1/chat/completions (chat completions, streaming, JSON mode,
  tools, vision). Native single-turn is /api/generate; use /v1 for multi-turn/OpenAI-client
  compatibility. List models at /v1/models. Structured outputs supported (JSON schema).
- vLLM: Same /v1/* paths as OpenAI. Extra vLLM-only knobs are passed as extra request params
  (e.g. enable_reasoning for reasoning models). Batch API at /v1/chat/completions/batch.
  Structured outputs are supported by default in the OpenAI-compatible server; pass
  response_format {type: json_object} or a JSON-schema for constrained decoding.
- TGI: Messages API gives OpenAI compatibility over /v1/chat/completions; also exposes
  /health, /metrics, /info for liveness and observability.
- LM Studio: OpenAI-compatible /v1/chat/completions; set the API key field to anything
  (it usually does not require one).

### JSON mode / response_format json_object

- Requesting { "type": "json_object" } makes the server constrain output to valid JSON, which is
  exactly what a classification endpoint wants (e.g. { "genres": [...], "mood": "...", "labels": [...] }).
- Constrained / structured decoding (vLLM, TGI, Ollama all now support JSON-schema structured
  outputs) is stronger than free-form json_object: it validates against a schema and guarantees
  the requested fields exist. Prefer schema-based structured outputs when the backend supports them;
  fall back to json_object + client-side validation (Pydantic) otherwise.
- Always validate on the client (Pydantic model in the backend) even when the server promises
  structured output - different backends disagree on edge cases, and you want a single, clear error
  path. (See the vLLM bug where response_format emitted a doubled leading brace - client validation
  catches that.)

### Auto-discovering the base URL

Strategy: try a small ordered list of well-known defaults, probe with a cheap GET /v1/models
(or GET / or health), and fall through to a user-configured URL.

- Ollama default is http://localhost:11434 (the AI SDK default prefix is http://localhost:11434/api).
  Probe GET http://localhost:11434/api/tags (native) or /v1/models. Auto-detection of a local
  Ollama at 127.0.0.1:11434 is a common built-in behavior in client apps.
- vLLM base is <host>/v1; probe GET /v1/models.
- TGI probe GET /health or GET /info.
- LM Studio probe GET /v1/models on its configured port (default 1234).

    async def discover(base_url):
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{base_url.rstrip('/')}/models")
            r.raise_for_status()
            return r.json()

Allow an explicit BASE_URL / OLLAMA_BASE_URL env override to beat the auto-probe (important when
running in Docker - see section 5, where localhost is not the host).

---

## 2. Latency, throughput & resilience

### Throughput vs. latency tradeoffs (what the benchmarks say)

- vLLM / TGI are throughput engines: continuous batching + PagedAttention (vLLM) let them serve
  many concurrent requests on the same GPU. Red Hat benchmarking on equal hardware showed vLLM
  peaking around 793 tokens/s vs Ollama ~41 tokens/s - a large concurrency gap.
- Ollama is designed for local, single-user inference: smooth and simple below ~5 concurrent
  users, but it flattens out (roughly ~20 requests/s) and latency/P99 climbs fast under load.
- Recommendation for this app: classification prompts are short and low-concurrency, so Ollama
  is the right default for local/dev and user-hosted models, with vLLM/TGI as the scale-out
  option when the user runs a shared GPU server or many users.

### Make calls resilient

httpx ships with no retries built in; you must add timeouts and retry/backoff yourself (or via
httpx-retry / tenacity / backoff / Pydantic http-request-retries).

1. Timeouts - set both connect and read timeouts separately. LLM streaming can take a long
   time to produce the first token; give read a generous budget (e.g. 120-300s) and keep
   connect tight (5s).
2. Retry with backoff - retry on connection errors, timeouts, and 429/500/502/503/504; respect
   Retry-After; use exponential backoff with jitter; cap total attempts and total elapsed time.
   httpx itself does not honor Retry-After, so implement it explicitly.
3. Graceful fallback when unreachable - probe health, then:
   - Return a clear "inference backend unreachable" error (do not hang the request).
   - Fallback tiers: (a) configured endpoint -> (b) next candidate in the default-URL list ->
     (c) a smaller local model -> (d) a deterministic heuristic classification (e.g. keyword/emoji
     based genre guess) so the app stays usable even with no model.
4. Circuit breaking / short-circuit - if a host fails health probes N times, stop hitting it for
   a cool-down window and surface a cached/heuristic result.
5. Client-side validation as a safety net - wrap every response in a Pydantic model; on parse
   failure, retry once, then fall back.

    from tenacity import retry, wait_exponential, stop_after_attempt, retry_if_exception_type
    import httpx

    @retry(wait=wait_exponential(multiplier=0.5, max=8),
           stop=stop_after_attempt(3), retry=retry_if_exception_type((httpx.TimeoutException, httpx.ConnectError)))
    async def classify(client, url, model, prompt):
        r = await client.post(f"{url}/chat/completions", json={...})
        r.raise_for_status()
        return MySchema.model_validate_json(r.json()["choices"][0]["message"]["content"])

---

## 3. Recommended full-stack

### Backend - FastAPI + SQLAlchemy 2.0 async + aiosqlite + httpx

- FastAPI: async-native, auto OpenAPI docs (handy for exposing the inference client as a library),
  Pydantic v2 validation that doubles as the classification schema and config model.
- SQLAlchemy 2.0 async with aiosqlite for dev/self-host (zero external DB process). For production,
  switch the dialect to asyncpg + PostgreSQL - same ORM code, better concurrency.
  pip install "sqlalchemy[asyncio]" aiosqlite (and asyncpg for prod). Async SQLAlchemy has been
  first-class since 1.4 and stable in 2.0, integrating cleanly with FastAPI.
- httpx: the async HTTP client for talking to inference backends (supports timeouts, streams, and
  mounts for retries).
- Why: minimal ops footprint (sqlite for self-host), first-class async, strong typing, and the
  Pydantic models are reused as the JSON classification contract against every backend.

### Frontend - React + Vite + shadcn/ui (with MUI/Data-Grid for the "fuller" app)

- React 19 + Vite is the current default, fast dev/build.
- shadcn/ui (Radix primitives + Tailwind) is the modern recommendation: composable, ownable
  components, small bundle - great for a polished settings/UX surface (pick a backend, set base
  URL, manage models, tune prompts).
- For a "fuller" app with a data-dense classification history UI, layer MUI (or MUI X / Material
  React Table + Data Grid), which gives built-in filtering, sorting, aggregation out of the box -
  less custom code than shadcn for big tables. Use shadcn for chrome/settings and MUI Data Grid
  for the classifications table.
- Data fetching / caching: TanStack Query (React Query) v5 - server-state caching, retries,
  background refetch. This is the de-facto standard alongside Vite+shadcn now.
- Search/filter library: lean on MUI Data Grid's built-in filter panel (column filters, quick
  filter, regex) - for anything more exotic, React Query Builder (AND/OR rule composition).
  Keep pagination server-side (backend endpoint) rather than client-side.
- Why: Vite for speed, shadcn for a clean configurable UI, MUI Data Grid for the fuller
  data-dense experience with zero custom filtering code, TanStack Query for resilient data flow.

---

## 4. Docker multi-stage build (Python + Node)

Separate build-time deps from runtime to shrink the image and reduce attack surface. Typical shape:
one stage builds the Node frontend, one builds/installs the Python backend; a final stage copies
only the artifacts.

    # ---- frontend build ----
    FROM node:20-alpine AS frontend
    WORKDIR /web
    COPY frontend/package.json frontend/package-lock.json* ./
    RUN npm ci
    COPY frontend/ ./
    RUN npm run build            # -> frontend/dist

    # ---- backend build (wheels) ----
    FROM python:3.12-slim-bookworm AS backend-build
    WORKDIR /app
    ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
    COPY backend/requirements.txt ./
    RUN pip wheel --no-cache-dir --wheel-dir /app/wheels -r requirements.txt
    COPY backend/ ./

    # ---- runtime ----
    FROM python:3.12-slim-bookworm AS runtime
    WORKDIR /app
    ENV PYTHONUNBUFFERED=1
    RUN apt-get update && apt-get install -y --no-install-recommends curl \
        && rm -rf /var/lib/apt/lists/*
    COPY --from=backend-build ["/app/wheels", "/wheels"]
    RUN pip install --no-cache-dir /wheels/*
    COPY --from=backend-build ["/app", "/app"]
    COPY --from=frontend   ["/web/dist", "/app/static"]
    EXPOSE 8000
    CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

- Build stages need the compilers/npm; the runtime stage carries only what is needed to run.
- Copy built artifacts (dist, installed wheels) rather than source into the final image.
- Add curl only if the runtime needs to self-probe health; otherwise skip.

---

## 5. docker-compose wiring (api + frontend + optional inference proxy)

Key gotcha (from the harness notes and common Docker experience): a sibling container's
localhost is not your host's localhost. So:

- Inside the api container, http://inference:11434/v1 reaches another compose service named
  inference (same network).
- To reach an inference server on the host machine, use host.docker.internal:host-gateway
  (Linux Engine only, not automatic) -> http://host.docker.internal:11434/v1.
- Ollama running on the dev machine, with the API probing localhost, works for docker compose up
  on a single host only if the API is also on that host; in the compose network, use the gateway
  host.

    services:
      api:
        build: { context: ., dockerfile: Dockerfile }
        environment:
          INFERENCE_BASE_URL: "http://inference:11434/v1"
          INFERENCE_MODEL: "llama-3.1-8b"
          DB_URL: "sqlite+aiosqlite:///./playsense.db"
        ports: ["8000:8000"]
        depends_on: ["inference"]
        networks: [tracker]

      frontend:
        build: { context: ., dockerfile: Dockerfile }
        ports: ["3000:3000"]
        depends_on: ["api"]
        networks: [tracker]

      inference:
        image: ollama/ollama:latest
        ports: ["11434:11434"]
        volumes: ["ollama_data:/ollama/models"]
        networks: [tracker]
        # For vLLM instead: image: vllm/vllm-openai:latest
        #   command: ["--model", "llama-3.1-8b", "--served-model-name", "llama-3.1-8b"]

    volumes:
      ollama_data:

- The api talks to inference by service name; swap the inference service for a vLLM/TGI image when
  the user wants scale.
- If you put the frontend behind the FastAPI app (static files copied in section 4), a single Caddy/
  nginx edge (or FastAPI serving the built frontend) fronts both; otherwise run the Vite dev server
  in the container and proxy /api to api:8000.
- Keep model pulls out of the image (or do them at first boot via a small entrypoint that runs
  ollama pull) so images stay small and models are user-controlled.

---

## 6. Suggested routing flow (classification)

1. Resolve backend: env INFERENCE_BASE_URL > probe default list (Ollama /v1/models, vLLM, TGI health) > error.
2. List models (GET /v1/models); if user did not pin a model, pick the first.
3. POST /v1/chat/completions with response_format json_object (+ JSON schema if supported).
4. Parse into a Pydantic Classification schema; on failure, retry once then fall back.
5. Fallback chain: second backend -> smaller local model -> keyword heuristic -> explicit unreachable.
6. Persist result; surface status (which backend/model answered) in the UI.

---

## Citations / sources

Ollama:
- OpenAI compatibility (/v1/chat/completions, JSON mode, structured outputs): https://docs.ollama.com/api/openai-compatibility
- Structured outputs blog: https://ollama.com/blog/structured-outputs
- Native /api/generate vs /v1; default localhost:11434: https://www.promptquorum.com/local-llms/local-llm-openai-compatible-api
- Auth / serve / tags: https://docs.ollama.com/api/authentication

vLLM:
- OpenAI-compatible server endpoints: https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/
- Structured outputs (default, response_format): https://docs.vllm.ai/en/latest/features/structured_outputs/
- Continuous batching / PagedAttention: https://vllm.ai/blog/2025-09-05-anatomy-of-vllm ; https://www.runpod.io/articles/guides/vllm-pagedattention-continuous-batching

TGI:
- TGI repo (Rust/gRPC prod server): https://github.com/huggingface/text-generation-inference
- Messages API (OpenAI compat): https://huggingface.co/blog/tgi-messages-api
- Serve CLI / OpenAI SDK compat: https://huggingface.co/docs/transformers/en/serve-cli/serving

LM Studio:
- OpenAI-compatible local server overview: https://www.promptquorum.com/local-llms/local-llm-openai-compatible-api

Throughput / latency benchmarks:
- Red Hat Ollama vs vLLM (793 vs 41 TPS): https://developers.redhat.com/articles/2025/08/08/ollama-vs-vllm-deep-dive-performance-benchmarking
- vLLM vs Ollama vs TGI comparison: https://gingerlabs.ai/blog/vllm-vs-ollama-vs-tgi
- Practical prod serving vs local: https://deploybase.ai/articles/vllm-vs-ollama
- Below 5 users Ollama wins, higher concurrency vLLM: https://particula.tech/blog/ollama-vs-vllm-comparison

Resilience / httpx / retries:
- httpx async + timeouts: https://oneuptime.com/blog/post/2026-02-03-python-httpx-async-requests/view
- Retries: tenacity / backoff / httpx-retries: https://medium.com/@Praxen/5-httpx-backoff-clients-that-save-your-throughput-55f4319f0c50
- Pydantic http-request-retries: https://pydantic.dev/docs/ai/models/http-request-retries/

Full stack:
- FastAPI + SQLAlchemy 2.0 async + aiosqlite: https://blog.miguelgrinberg.com/post/sqlalchemy-2-in-practice---chapter-7-asynchronous-sqlalchemy ; https://blakecrosley.com/guides/fastapi-htmx
- shadcn/ui + Vite + TanStack Query as default; MUI Data Grid filtering/sorting: https://www.usedatabrain.com/how-to/create-react-dashboard ; https://www.material-react-table.com/ ; https://mui.com/x/react-data-grid/
- React libraries overview: https://www.robinwieruch.de/react-libraries/

Docker:
- Multi-stage builds docs: https://docs.docker.com/build/building/multi-stage/
- Python+Node multi-stage example: https://medium.com/@kdineshkvkl/one-question-changed-my-dockerfile-are-you-using-multi-stage-builds-38e3cf5138dc
- Why Node benefits from multi-stage: https://oneuptime.com/blog/post/2026-02-08-how-to-implement-the-builder-pattern-in-docker-multi-stage-builds/view
