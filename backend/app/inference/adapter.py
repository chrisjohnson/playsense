from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Optional
import httpx
from ..config import get_settings


CLASSIFICATION_SYSTEM_PROMPT = (
    "You are a music taxonomy expert. Given a Spotify track (artist names, album, title, "
    "release year, Spotify genres), decide whether it qualifies as Mexican or, more broadly, "
    "Latin American. Base your judgment only on the provided metadata. "
    "Distinguish, for example, Mexican regional/banda/norteño/mariachi and Mexican artists "
    "from reggaeton/latin-pop artists of Puerto Rico, Colombia, Cuba, etc. "
    "Return ONLY a JSON object (no prose) with keys: "
    "is_mexican (bool), is_latin_american (bool), region (string), language (string), "
    "confidence (0..1 float), reasoning (string), signal (string list)."
)

CLASSIFICATION_USER_TEMPLATE = (
    "Artist names: {artists}\n"
    "Album: {album}\n"
    "Title: {title}\n"
    "Release year: {year}\n"
    "Spotify genres: {genres}\n"
    "\n"
    "Classify per the instructions."
)

JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "is_mexican": {"type": "boolean"},
        "is_latin_american": {"type": "boolean"},
        "region": {"type": "string"},
        "language": {"type": "string"},
        "confidence": {"type": "number"},
        "reasoning": {"type": "string"},
        "signal": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["is_mexican", "is_latin_american", "region", "language", "confidence", "reasoning"],
    "additionalProperties": False,
}


@dataclass
class ClassificationResult:
    is_mexican: bool = False
    is_latin_american: bool = False
    region: str = ""
    language: str = ""
    confidence: float = 0.0
    reasoning: str = ""
    signal: list = field(default_factory=list)
    strategy: str = "none"
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict, strategy: str) -> "ClassificationResult":
        try:
            return cls(
                is_mexican=bool(d.get("is_mexican", False)),
                is_latin_american=bool(d.get("is_latin_american", False)),
                region=str(d.get("region", "") or ""),
                language=str(d.get("language", "") or ""),
                confidence=float(d.get("confidence", 0.0)),
                reasoning=str(d.get("reasoning", "") or ""),
                signal=list(d.get("signal", []) or []),
                strategy=strategy,
            )
        except (TypeError, ValueError) as e:
            return cls(strategy=strategy, error=str(e))


class InferenceAdapter:
    """OpenAI-compatible chat client used for semantic classification."""

    def __init__(self):
        self.settings = get_settings()
        self.base_url = self.settings.inference_base_url.rstrip("/")
        self.api_key = self.settings.inference_api_key or None
        self.model = self.settings.inference_model

    def chat(self, messages: list[dict]):
        url = self.base_url + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {
            "model": self.model,
            "messages": messages,
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }
        with httpx.Client(timeout=self.settings.inference_timeout_seconds) as client:
            r = client.post(url, json=payload, headers=headers)
            if r.status_code >= 400:
                raise RuntimeError(f"Inference {r.status_code}: {r.text[:500]}")
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            return content

    def classify(self, artists: list[str], album: str, title: str,
                 year: str, genres: list[str]) -> ClassificationResult:
        user_msg = CLASSIFICATION_USER_TEMPLATE.format(
            artists=", ".join(artists) or "?", album=album or "?", title=title or "?",
            year=year or "?", genres=", ".join(genres) or "none",
        )
        messages = [
            {"role": "system", "content": CLASSIFICATION_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ]
        try:
            content = self.chat(messages)
            parsed = json.loads(content)
            return ClassificationResult.from_dict(parsed, "llm")
        except Exception as e:
            return ClassificationResult(strategy="llm", error=str(e))
