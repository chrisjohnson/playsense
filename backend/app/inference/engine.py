from __future__ import annotations
import json
import re
from ..config import get_settings
from ..inference.adapter import InferenceAdapter, ClassificationResult

# Language: Spanish markers. Single-word markers match on whole tokens
# (never substrings - "y"/"mi"/"en" as substrings matched almost everything,
# which is why every track used to read language=es). Multi-word markers
# match as phrases.
LANG_ES_MARKERS = ["de la", "los", "las", "para", "una", "con",
                   "el", "la", "del", "es", "por"]

# Region signals. Single-word entries match whole tokens (variants listed
# explicitly); multi-word entries match as phrases. "grupo" was removed -
# it just means "group" in Spanish/Portuguese and matched Brazilian and
# Italian bands. "leon" (city) removed - it false-positived on artist names.
MEXICAN_REGION_SIGNALS = [
    "mexico", "mexican", "mexicana", "mexicanas",
    "banda", "bandas", "norteno", "norteño", "mariachi", "mariachis",
    "ranchera", "rancheras", "corrido", "corridos",
    "regional mexican", "grupero", "grupera", "tex-mex", "tex mex",
    "cumbia mexicana", "sierreno", "sierreño", "durangeno",
    "huapango", "huapangos", "son jalisciense", "son jarocho",
]
LATIN_AMERICA_SIGNALS = [
    "cumbia", "reggaeton", "reggaetón", "latin pop", "bachata", "salsa",
    "merengue", "dembow", "trap latino", "latin", "latino", "latina",
    "latin america", "colombia", "argentina", "chile", "peru", "cuba",
    "puerto rico", "venezuela", "guatemala", "bolivia", "paraguay",
    "ecuador", "dominican", "panama", "costa rica", "el salvador",
    "honduras", "nicaragua", "uruguay",
]
MEXICAN_CITIES = ["guadalajara", "monterrey", "ciudad mexico", "mexico city",
    "tijuana", "puebla", "torreon", "sinaloa", "chihuahua", "zacatecas",
    "cuernavaca"]

_WORD_RE = re.compile(r"[a-zà-öø-ÿ0-9]+")


def _tokens(text: str) -> set:
    return set(_WORD_RE.findall(text.lower()))


def _has(haystack: str, toks: set, sig: str) -> bool:
    """Token-aware signal match: phrases by containment, words by token.
    Substring matching ("leon" in "leonard") is the bug this replaces."""
    if " " in sig or "-" in sig:
        return sig in haystack or sig.replace("-", " ") in haystack
    return sig in toks


def _as_list(v) -> list:
    if isinstance(v, str):
        return [x for x in v.split(",") if x.strip()]
    return list(v or [])


def _join(x) -> str:
    return " ".join(_as_list(x)).lower()


def heuristic_classify(artists, album="", title="", year="", genres=""):
    """Return (is_mexican, is_latin_american, region, language, signals).

    language is "" when no Spanish marker was found - callers must NOT
    invent a default (that is how every track used to read es).
    """
    haystack = " ".join([_join(artists), _join(album), _join(title), _join(genres)])
    toks = _tokens(haystack)
    signals: list = []
    is_latin = False
    is_mex = False
    region = ""
    language = ""

    if any(_has(haystack, toks, m) for m in LANG_ES_MARKERS):
        language = "es"

    for sig in MEXICAN_REGION_SIGNALS:
        if _has(haystack, toks, sig):
            signals.append(sig)
            is_mex = True
    if any(_has(haystack, toks, c) for c in MEXICAN_CITIES):
        signals.append("mexican_city")
        is_mex = True

    for sig in LATIN_AMERICA_SIGNALS:
        if _has(haystack, toks, sig):
            signals.append(sig)
            is_latin = True

    if is_mex:
        is_latin = True
        region = "Mexico"
    elif is_latin:
        region = "Latin America"

    return is_mex, is_latin, region, language, signals


class ClassificationEngine:
    """Hybrid: structured/heuristic first; LLM only when uncertain."""

    def __init__(self):
        self.settings = get_settings()
        self.threshold = self.settings.semantic_confidence_threshold
        self.llm = InferenceAdapter()

    def classify(self, artists, album="", title="", year="", genres="",
                 use_semantic: bool = True) -> ClassificationResult:
        is_mex, is_latin, region, language, signals = heuristic_classify(
            artists, album, title, year, genres)
        if signals:
            conf = 0.9
            if (is_mex or is_latin) and conf >= self.threshold:
                return ClassificationResult(
                    is_mexican=is_mex, is_latin_american=is_latin, region=region,
                    language=language,
                    confidence=conf, reasoning="keyword heuristic", signal=signals, strategy="keyword",
                )
        if use_semantic:
            res = self.llm.classify(
                _as_list(artists), album, title, year, _as_list(genres))
            if res.error:
                # Semantic inference failed (e.g. LLM endpoint down). The
                # adapter's fallback returns empty defaults that would
                # falsely mark the track as non-Latin, so surface the
                # heuristic finding flagged as uncertain instead. The
                # strategy stays distinct from "llm" so a run does not
                # report LLM use for a call that never succeeded.
                return ClassificationResult(
                    is_mexican=is_mex, is_latin_american=is_latin,
                    region=region, language=language,
                    confidence=0.0,
                    reasoning="semantic inference unavailable: " + str(res.error),
                    signal=[], strategy="semantic_unavailable")
            return res
        return ClassificationResult(strategy="none", confidence=0.0,
            reasoning="no signal; semantic disabled")


def load_track_fields(track) -> dict:
    return {
        "artists": json.loads(track.artists or "[]"),
        "album": track.album_name or "",
        "title": track.name or "",
        "year": (track.release_date or "")[:4],
        "genres": json.loads(track.genres or "[]"),
    }
