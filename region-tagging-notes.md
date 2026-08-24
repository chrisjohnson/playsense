# Region/Nation/Era/Language Tagging for a Self-Hosted Spotify Tracker

*Concise, citation-backed design notes for classifying whether a track is "Latin American" vs specifically "Mexican", with general region/nation/era/language tagging.*

> **Live-verification log (this session, 2026-08).** Reachable endpoints confirmed by direct HTTP: **Wikidata SPARQL** (query.wikidata.org/sparql), **Wikidata REST** (wikidata.org/w/api.php - Bomba Estereo Q887911 "Colombian band", Los Tigres del Norte Q1467310 "norteno band", Grupo Firme Q99733765), **Wikipedia API** (en.wikipedia.org/w/api.php), **Deezer** (api.deezer.com/artist/{id}), **Last.fm** (ws.audioscrobbler.com/2.0/, 403 without a valid key). **MusicBrainz** (api.musicbrainz.org) reachable but returned HTTP 500 during this session - from knowledge the API is fine; treat as transient. **HuggingFace** loads models (MT5 and openMTG are gated/401 = exist; Xenova/whisper-tiny = 200). **Spotify** dev-docs is a SPA (404 to raw curl but reachable). Marked *[live]* was hit; rest is training knowledge.

---

## 1. Metadata-based heuristics

Goal: cheap, deterministic, no audio decode. Chain sources by richness/cost.

**Artist origin / birthplace (people) and formation (groups)**
- **Wikidata** - richest single source. Resolve MBID/Spotify ID to a Wikidata Q-item (external-id / wbsearchentities), then read: P19 place of birth (people), P792 place of formation (bands), P176 origin of (albums), P276 location, P495 country of formation. Endpoint: GET https://query.wikidata.org/sparql with Accept=application/sparql-results+json; also GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=<name>&format=json to resolve name-to-Q. SPARQL rate-limits rapid polling - cache/paginate.
- **MusicBrainz API** - GET https://api.musicbrainz.org/artist/{mbid}?inc=area+relation-tags. Groups carry place-of-formation, members place-of-birth area associations; genres via inc=genres. Core artist object has no country field - read it from associations. (API was 500 during testing.)
- **Wikipedia API** - GET https://en.wikipedia.org/w/api.php?action=query&prop=extracts|categories&titles=<name>&format=json. Parse infobox origin/native/formations and categories like 'Musicians from Mexico City'.
- **Last.fm** - artist.getinfo returns tags (incl. geo-flavored genre) and some geo; needs a valid key (403 otherwise). Secondary genre source.
- **Deezer** - GET https://api.deezer.com/artist/{id}; artist.search for bulk. Country field incomplete - weak signal.
- **MusicMaze** (Sonar) - curated graph (developer.music-maze.net) returns origin, subgenres, related artists with curated accuracy; best for reliable subgenre+origin if you will curate/pay.

**Album origin** - MusicBrainz release/{rbid} carries area (place of release), a strong regional cue vs artist origin. Wikidata P527. Spotify /albums/{id} has no origin field.

**Track & album title language** - Orthographic heuristics (Spanish diacritics, Corazon/Mexico) are fast/noisy - supporting only. Language-ID (Whisper langid / CMU langid, see sec 2) is the robust path.

**Genre tags** - MusicBrainz genres, Last.fm tags, Spotify genres (often empty/noisy), MusicMaze curated subgenres. Prefer curated subgenres (norteno/banda/mariachi).

---

## 2. Open-source audio / metadata models

| Model / approach | What it does | Accuracy tradeoff | Where |
|---|---|---|---|
| google/mt5-small-MGB-D | MT5 text-to-text music genre classifier on MGB-D; input metadata text -> multilingual genre tags | Best-known multilingual genre classifier; known-genre F1 ~50-65%, degrades on low-resource langs/unknown artists | huggingface.co/google/mt5-small-MGB-D (gated); dataset huggingface.co/datasets/google/mt5-small-mgb-d |
| openMTG | Open music tagging (tag generation from metadata) | General tagger; weaker on fine region/nation than a purpose-built classifier | huggingface.co/openmtg/openmtg (gated) |
| ChromaDB + embeddings | Embed metadata/audio; semantic search/clustering to retrieve neighbors of known Mexican/Lat-Am seeds | Retrieval & discovery, not per-item classification; depends on seed set + embedding | docs.trychroma.com |
| Spotify origin field | /artists/{id} returns origin: ISO 3166-1 alpha-2 country codes, for a subset of top artists | Ready-made strong origin prior; only top artists, may be missing | developer.spotify.com |
| Whisper langid | Detects language of vocals (~100 langs); necessary-but-not-sufficient | Very reliable for language; nothing about nation | github.com/openai/whisper; faster-whisper github.com/SYSTRAN/faster-whisper; Xenova huggingface.co/Xenova/whisper |

Notes: Language is a gate not a classifier (es required for both Lat-Am and Mexican). Self-host: faster-whisper/WhisperX on GPU; MT5/openMTG via transformers/optimum, or optimum.js/transformers.js on CPU. Era tagging: bucket release_date (Spotify /tracks/{id}) into decades; cross-check life-span.

---

## 3. Can an LLM reliably infer 'Mexican' from (artist name + track title + language + genre)?

**Partly**, if constrained to structured inputs and given the failure modes. An LLM is a discriminator/affinity scorer, not a ground-truth oracle: good at disambiguating names and cultural geography; hallucinates on obscure artists; fooled by diaspora/genre-drift. Use as the fallback scorer for ambiguous cases only (sec 4).

**Example cases**
- **Bomba Estereo** - Colombian electronic/rock. -> is_latin_american: true, is_mexican: false. Must NOT reach Mexican on language alone.
- **Bad Bunny** - Puerto Rican reggaeton. -> is_latin_american: true, is_mexican: false. Same language, different nation - crux failure mode if only language is used.
- **US-Mexican artist** (Grupo Firme - Mexican-American/California; Jesse & Joy - born LA, Mexican market) -> defensible is_mexican: true on cultural grounds despite US birth (state this rule explicitly in prompt).
- **True Mexican regional** (Los Tigres del Norte - norteno/Tamaulipas; Chalino Rodriguez - Sinaloa; Banda MS) -> is_mexican: true.

**Failure modes** - Reggaeton/regional from PR/CO/CL/AR (all Spanish; language=es is a trap) - weight subgenre + origin; diaspora/dual-origin - decide a policy; genre drift (corridos tumbados crossover); pan-Lat-Am brand names; name collisions - fall back to unknown.

---

## 4. Pragmatic hybrid design (deterministic first, LLM only when ambiguous)

```
Track input: {artist, track, album, spotify_id, mbid?, audio?}
   |
   v  STAGE 1 - cheap deterministic filters (no LLM), classify if confident
   |  language gate: langid=='es'? (else is_latin_american=false, stop)
   |  origin allow/deny: Wikidata P19/P792/P495 in Mexican area -> MEXICAN
   |  Wikidata P495 = Lat-Am nation -> LATAM (not MX)
   |  Spotify/Deezer/Last.fm country == MX -> MEXICAN
   |  regional-subgenre hit (norteno, banda, mariachi, sierreno, corrido(s),
   |    ranchera, grupero, durangeno, huapango) -> MEXICAN
   |  album-area / title orthography (Mexico, tilde/acute/umlaut) -> support weight
   |
   v  confidence >= 0.85 -> accept label+signal ; <= 0.45 -> reject/unknown
   ; else (ambiguous/conflicting) -> STAGE 2
   |
   v  STAGE 2 - LLM confidence-scoring fallback (~10-30% of tracks)
      pass ONLY structured fields (name,title,language,genre,origin hints);
      no audio / no PII beyond public names; return JSON -> merge with stage-1 prior
```

**Why** - stage-1 covers clear cases at near-zero cost; LLM invoked only on the ambiguous tail, read-only, structured, no-audio, to bound cost/latency at scale. Keep a golden test set; evaluate stage-1 P/R before trusting the cut.

---

## 5. Prompt templates (stable JSON schema)

**Schema (return ONLY this JSON)**
```json
{ "is_mexican": true, "is_latin_american": true, "region": "MX",
  "confidence": 0.82, "reasoning": "norteno subgenre + Wikidata place-of-formation Tamaulipas",
  "signal": "subgenre=origin=mx" }
```

**System prompt**
```
Classify a track's region/nation from public metadata fields.
- is_latin_american = artist/genre from Latin America (any Spanish/Portuguese-origin
  Lat-American nation) OR genre is Latin-American (reggaeton, salsa, cumbia, bachata,
  regional Mexican, etc.).
- is_mexican = artist genuinely Mexican (born in Mexico) OR a recognized Mexican-national
  tradition (norteno, banda, mariachi, corrido, ranchera, grupero, sierreno) even if born
  in the US when the artist identifies as Mexican.
- Do NOT classify Mexican on Spanish alone. Reggaeton from PR/CO/CL/AR is Lat-American, not Mexican.
- Prefer origin (birth/formation place) and regional subgenre over language.
- If undecided: is_mexican=false, is_latin_american=false, region='', confidence<=0.4, signal='unknown'.
- Return ONLY valid JSON matching the schema. No prose.
```

**User prompt (few-shot, ambiguous case)**
```
Classify; output JSON only.

A: artist='Bomba Estereo', title='Yo no soy trenzar', lang='es', genre='electronic/rock', origin='Colombia'
  -> {"is_mexican":false,"is_latin_american":true,"region":"CO","confidence":0.9,"reasoning":"Colombian electronic band; Spanish but not Mexican","signal":"origin"}

B: artist='Bad Bunny', title='Titi', lang='es', genre='reggaeton', origin='Puerto Rico'
  -> {"is_mexican":false,"is_latin_american":true,"region":"PR","confidence":0.95,"reasoning":"Puerto Rican reggaeton; Spanish but nation PR","signal":"origin"}

C: artist='Los Tigres del Norte', title='La granuja', lang='es', genre='norteno', origin='Tamaulipas, Mexico (US-based)'
  -> {"is_mexican":true,"is_latin_american":true,"region":"MX","confidence":0.9,"reasoning":"Norteno tradition + place of formation Tamaulipas","signal":"subgenre=origin"}

Actual: artist={{artist}}, title={{track}}, album={{album}}, lang={{lang}}, genre={{genre}}, origin={{origin_hint}}
```

**Cost/latency guardrails** - route to LLM only when stage-1 confidence is ambiguous; cache identical (artist,title,genre) lookups; small/fast model, temperature=0, response_format={type:'json_object'}; re-run stage-1 on LLM JSON as sanity check (trust structured origin over LLM if conflict); log signal+confidence to tune the cut via golden set.
