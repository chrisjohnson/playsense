#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock LLM for local development.

Lets the full LLM paths (InferenceAdapter.relevance_batch -> search.run_search
and InferenceAdapter.classify -> ClassificationEngine) be exercised without a
real model. It answers deterministically with keyword/token-based logic in the
exact JSON shapes the adapter expects, so parsing/filtering/sorting/render are
genuinely covered.

    python3 mock_llm_server.py [port]     # default 8901

As a sibling container on the app network:
    docker run -d --name llm-mock --restart unless-stopped \
      --network sp-tracker-net \
      -v <repo-host-path>/backend/tests/mock_llm_server.py:/mock.py:ro \
      python:3.12-slim python3 /mock.py 8901
then point INFERENCE_BASE_URL=http://llm-mock:8901/v1 INFERENCE_MODEL=mock-moe
at the api container.
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- token/phrase signals (mirror of backend/app/inference/engine.py) -------
MEXICAN = ["mexico", "mexican", "mexicana", "mexicanas", "banda", "bandas",
           "norteno", "norteño", "mariachi", "mariachis", "ranchera", "rancheras",
           "corrido", "corridos", "regional mexican", "grupero", "grupera",
           "tex-mex", "tex mex", "cumbia mexicana", "sierreno", "sierreño",
           "durangeno", "huapango", "huapangos", "son jalisciense", "son jarocho",
           "guadalajara", "monterrey", "ciudad mexico", "mexico city", "tijuana",
           "puebla", "torreon", "sinaloa", "chihuahua", "zacatecas", "cuernavaca"]
LATIN = ["cumbia", "reggaeton", "reggaetón", "latin pop", "bachata", "salsa",
         "merengue", "dembow", "trap latino", "latin", "latino", "latina",
         "latin america", "colombia", "argentina", "chile", "peru", "cuba",
         "puerto rico", "venezuela", "guatemala", "bolivia", "paraguay",
         "ecuador", "dominican", "panama", "costa rica", "el salvador",
         "honduras", "nicaragua", "uruguay"]
ES_MARKERS = ["de la", "los", "las", "para", "una", "con", "el", "la", "del",
              "es", "por"]
_WORD_RE = re.compile(r"[a-zà-öø-ÿ0-9]+")
LINE_RE = re.compile(r'^(\d+): artists=\[(.*?)\] title="(.*)" album="(.*)" year=(\S+)', re.M)


def _match(haystack: str, toks: set, sig: str) -> bool:
    if " " in sig or "-" in sig:
        return sig in haystack or sig.replace("-", " ") in haystack
    return sig in toks


def answer_relevance(user: str) -> dict:
    m = re.search(r"^Query:\s*(.+)$", user, re.M)
    query = (m.group(1).strip().lower() if m else "")
    tokens = [t for t in re.split(r"\W+", query) if len(t) >= 2]
    results = []
    for idx, artists, title, album, _year in LINE_RE.findall(user):
        hay = f"{artists} {title} {album}".lower()
        score = (sum(1 for t in tokens if t in hay) / len(tokens)) if tokens else 1.0
        results.append({
            "id": int(idx),
            "relevant": score >= 0.5,
            "score": round(score, 2),
            "reason": "mock keyword match" if score > 0 else "no token overlap",
        })
    return {"results": results}


def answer_classification(user: str) -> dict:
    def field(name):
        m = re.search(rf"^{name}:\s*(.+)$", user, re.M)
        return m.group(1).strip() if m else ""
    text = " ".join([field("Artist names"), field("Album"), field("Title"),
                     field("Spotify genres")]).lower()
    toks = set(_WORD_RE.findall(text))
    mex = [s for s in MEXICAN if _match(text, toks, s)]
    lat = [s for s in LATIN if _match(text, toks, s)]
    is_mex = bool(mex)
    is_latin = is_mex or bool(lat)
    return {
        "is_mexican": is_mex,
        "is_latin_american": is_latin,
        "region": "Mexico" if is_mex else ("Latin America" if is_latin else ""),
        "language": "es" if any(_match(text, toks, m) for m in ES_MARKERS) else "",
        "confidence": 0.9 if (mex or lat) else 0.3,
        "reasoning": ("mock token match: " + ", ".join((mex + lat)[:3])) if (mex or lat)
        else "no mock token signal",
        "signal": (mex + lat)[:6],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the log quiet
        pass

    def _send(self, code: int, obj: dict):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"data": [{"id": "mock-moe"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "bad json"})
            return
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": "not found"})
            return
        user = next((m.get("content", "") for m in body.get("messages", [])
                     if m.get("role") == "user"), "")
        if user.startswith("Query:"):
            obj = answer_relevance(user)
        elif "Artist names:" in user:
            obj = answer_classification(user)
        else:
            # Unknown prompt: answer with an object that is NOT a valid
            # classification (all required fields missing) so the adapter
            # surfaces a semantic failure instead of fake defaults.
            obj = {"error": "mock: unrecognized prompt format"}
        content = json.dumps(obj)
        self._send(200, {
            "id": "mock-1", "object": "chat.completion",
            "model": body.get("model", "mock-moe"),
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
        })


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
    print(f"mock llm listening on :{port}", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()
