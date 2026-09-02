from __future__ import annotations
import json
import httpx
from ..config import get_settings


RELEVANCE_SYSTEM_PROMPT = (
    "You are a precise music search assistant. You receive a natural-language "
    "query and a numbered list of tracks (index, artists, title, album, year). "
    "A track is relevant only if it would genuinely satisfy the query: the same "
    "song, artist or album, or a strong topical/style match. When in doubt, "
    "mark it not relevant. Return ONLY a JSON object with key \"results\": an "
    "array with exactly one entry per track, each "
    "{\"id\": <index from the list>, \"relevant\": <bool>, \"score\": <float 0..1>, "
    "\"reason\": \"<max 8 words>\"}."
)

RELEVANCE_USER_TEMPLATE = (
    "Query: {query}\n"
    "Tracks:\n{tracks}\n"
    "Return the JSON results."
)

class InferenceAdapter:
    """OpenAI-compatible chat client for the LLM call paths."""

    def __init__(self):
        self.settings = get_settings()
        self.base_url = self.settings.inference_base_url.rstrip("/")
        self.api_key = self.settings.inference_api_key or None
        self.model = self.settings.inference_model

    def _post_chat(self, payload: dict) -> str:
        url = self.base_url + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        # connect fast (a dead backend should fail in seconds, not hang the job
        # thread), read long (a live but slow model grinding on a 25-track chunk
        # can legitimately take a couple of minutes)
        timeout = httpx.Timeout(self.settings.inference_timeout_seconds, connect=15)
        with httpx.Client(timeout=timeout) as client:
            r = client.post(url, json=payload, headers=headers)
            if r.status_code >= 400:
                raise RuntimeError(f"Inference {r.status_code}: {r.text[:500]}")
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            if not content or not content.strip():
                raise RuntimeError("Inference returned empty content")
            return content

    def chat(self, messages: list[dict]):
        return self._post_chat({
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "response_format": {"type": "json_object"},
        })

    def chat_structured(self, messages: list[dict], json_schema: dict) -> str:
        """Chat with a strict JSON schema attached to the request.

        Sends response_format json_schema when the provider honors it; if the
        proxy/model rejects it (400), retries once with plain json_object —
        the schema is also embedded in the system prompt by the caller, so
        the answer is still expected to conform (and IS validated on the way
        in). Returns the raw content string."""
        base = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
        }
        try:
            return self._post_chat({**base, "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "classifier_response",
                    "strict": True,
                    "schema": json_schema,
                },
            }})
        except RuntimeError as e:
            if "Inference 400" not in str(e):
                raise
            return self._post_chat({**base, "response_format": {"type": "json_object"}})

    def relevance_batch(self, query: str, tracks: list) -> dict:
        """Score a batch of slim tracks against a free-text query (one LLM call).

        tracks: [{"id": int, "title": str, "artists": [str], "album": str, "year": str}]
        Returns {track_id: {"relevant": bool, "score": float, "reason": str}}.
        Raises on any failure — the caller decides the fallback (keyword match).
        """
        lines = []
        for i, t in enumerate(tracks):
            artists = ", ".join(t.get("artists") or []) or "?"
            title = str(t.get("title") or "?").replace('"', "'")
            album = str(t.get("album") or "?").replace('"', "'")
            lines.append(
                f'{i}: artists=[{artists}] title="{title}" '
                f'album="{album}" year={t.get("year") or "?"}'
            )
        user_msg = RELEVANCE_USER_TEMPLATE.format(query=query, tracks="\n".join(lines))
        content = self.chat([
            {"role": "system", "content": RELEVANCE_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ])
        data = json.loads(content)
        # The model answers with the list index (the tracks were sent numbered
        # 0..n-1); map that back onto each track's real id.
        out = {}
        for r in data.get("results", []):
            try:
                idx = int(r["id"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (0 <= idx < len(tracks)):
                continue
            out[tracks[idx]["id"]] = {
                "relevant": bool(r.get("relevant", False)),
                "score": float(r.get("score", 0.0)),
                "reason": str(r.get("reason", ""))[:140],
            }
        return out
