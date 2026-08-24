from __future__ import annotations
import json
from ..config import get_settings
from ..inference.adapter import InferenceAdapter, ClassificationResult

LANG_ES_MARKERS = ["de la", "los", "las", "para", "y", "una", "una", "mi", "con", "en"]
MEXICAN_REGION_SIGNALS = ["mexico", "mexican", "mexicana", "banda", "norteno",
    "mariachi", "ranchera", "corrido", "banda sinaloense", "grupo", "regional mexican",
    "grupero", "tex-mex", "cumbia mexicana", "sierreno", "durangeno", "huapango",
    "son jaliscience", "son jarocho"]
LATIN_AMERICA_SIGNALS = ["cumbia", "reggaeton", "latin pop", "bachata", "salsa",
    "merengue", "dembow", "trap latino", "latin", "latin america", "latino", "colombia",
    "argentina", "chile", "peru", "cuba", "puerto rico", "venezuela", "guatemala", "bolivia",
    "paraguay", "ecuador", "dominican", "panama", "costa rica", "el salvador", "honduras",
    "nicaragua", "uruguay"]
MEXICAN_CITIES = ["guadalajara", "monterrey", "ciudad mexico", "mexico city", "tijuana",
    "leon", "puebla", "torreon", "sinaloa", "chihuahua", "zacatecas", "cuernavaca"]


def _as_list(v) -> list:
    if isinstance(v, str):
        return [x for x in v.split(",") if x.strip()]
    return list(v or [])


def _join(x) -> str:
    return " ".join(_as_list(x)).lower()


def heuristic_classify(artists, album="", title="", year="", genres=""):
    """Return (is_mexican, is_latin_american, region, language, signals)."""
    haystack = " ".join([_join(artists), _join(album), _join(title), _join(genres)])
    signals: list = []
    is_latin = False
    is_mex = False
    region = ""
    language = ""

    if any(s in haystack for s in LANG_ES_MARKERS) or _join(title).startswith("es"):
        language = "es"

    for sig in MEXICAN_REGION_SIGNALS:
        if sig in haystack:
            signals.append(sig)
            is_mex = True
    if any(c in haystack for c in MEXICAN_CITIES):
        signals.append("mexican_city")
        is_mex = True

    for sig in LATIN_AMERICA_SIGNALS:
        if sig in haystack:
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
                    language=language or "es",
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
                    region=region, language=language or "es",
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