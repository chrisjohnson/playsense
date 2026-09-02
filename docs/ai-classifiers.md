# AI Classifiers — Design Document

## 1. Vision

The search experience has **zero LLM involvement at query time**. It is a
fast, filterable list over pre-computed data, exactly like a good-quality
web app's filterable table:

1. **Static metadata** — everything Spotify gives us and we persist
   (title, artists, album, release date, duration, language). Filtered with
   plain structured filters; the free-text box is an *instant fuzzy match*
   over these fields. No network round-trip, no model, no latency.
2. **Dynamic metadata ("AI fields")** — extra columns that do not exist in
   Spotify's data, produced by **classifiers**: a natural-language question
   ("music that is mexican, mexican-inspired, or by a mexican artist") that
   a background batch job feeds the *entire playlist's metadata* through the
   LLM in chunks. The result is a typed value per track, stored in the DB.
   Once computed, AI fields are **just more filter columns** on the search
   page — instant, because pre-computed.

The LLM is a *batch data producer*, never a query-time service. Every LLM
failure is a missing/stale value, never a wrong or hung search.

## 2. Core concepts

### Classifier
A named, versioned natural-language definition of a metadata field.

- `name` — short human label shown in the UI (e.g. "Mexican").
- `query` — the natural-language instruction the LLM evaluates each track
  against. This is the classifier's *definition*; editing it changes the field.
- `field_type` — `boolean` | `string` | `number` | `datetime`. Determines
  (a) the JSON schema the LLM must return, (b) how the value is validated,
  and (c) which filter widget the search page renders for it.
- `revision` — integer, starts at 1, **bumped every time the classifier's
  query or field_type changes**. All stored values produced by an older
  revision are *stale* (see below).

### Field types and value storage

Values are stored as **JSON text** in one loose column, with the expected
shape dictated by the classifier's `field_type` at write time:

| type     | JSON value        | example filter widget            |
|----------|-------------------|----------------------------------|
| boolean  | `true`/`false`    | checkbox                         |
| string   | `"regional mexican"`| text-contains / select (distinct) |
| number   | `0.82`            | min–max numeric                  |
| datetime | `"2024-05-01T..."`| date range                       |

Because storage is JSON, a field can **change type across revisions**
(e.g. "Mexican" starts boolean, later becomes string "mexican | latin | none")
without a schema migration — the old values simply become stale and get
re-validated under the new type. Validation happens at *write* time against
the current revision's type; rows of a mismatched type are treated as stale.

### TrackClassification
One row per (track, classifier) — an upsert, not a history table:

- `value` — JSON text, loose-typed as above.
- `classifier_revision` — the revision that produced the value.
- `classified_at` — timestamp.

**Staleness is derived, not stored**: a track is *classified* for a
classifier iff its row's `classifier_revision` equals the classifier's
current revision (and the value parses as the current field_type). Editing a
classifier bumps the revision → every existing row is instantly stale with
no row updates. "Has this track been classified?" is a join, never a flag
to keep in sync.

## 3. Lifecycle

```
new classifier ──► type inference (1st-pass LLM call, optional)
                ──► job manager enqueues: all tracks of every playlist
                ──► chunked batch run (see §4) writes values
                ──► search page shows the field as a filter

edit classifier (query/type) ──► revision += 1 ──► all values stale
                               ──► job manager re-enqueues everything

new track downloaded ──► enqueued under every active classifier
                        (download worker hook, §5)

classifier deleted ──► values deleted with it
```

### Type inference (first pass)
When a classifier is created without an explicit `field_type`, one small
LLM call asks the model what kind of value the question produces for a track
("true/false? a label? a number? a date?"), constrained to the four types.
Cheap, single prompt, deterministic answer. If the call fails, creation
still succeeds with `field_type=null` — the field is hidden in search until
a type exists (manual or inferred).

## 4. Batch run pipeline (built: `app/jobmanager.py` + `app/api/classifier_jobs.py`)

A background **job manager** (its own table: `classifier_jobs`) watches for
work: new classifiers, stale values (revision bumps), new tracks. For each
unit of work it runs:

1. Select unclassified/stale tracks (bounded page size).
2. Chunk them (default 25 tracks/call — keeps prompts small; a 5k playlist
   is ~210 calls, which is why this is batch, never query-time).
3. One LLM call per chunk with:
   - a **strict JSON schema** in the request (`response_format:
     json_schema` where the provider supports it; the schema is *also*
     embedded in the system prompt as a fallback instruction, because not
     every proxy/model honors the structured-output parameter),
   - the classifier query as the evaluation instruction,
   - each track's static metadata (title, artists, album, release date,
     duration, language, genre when available), numbered,
   - a required response: one entry per track index with `value` (+ optional
     short one-clause `reason`, persisted to `track_classifications.reason`
      (see §5.1).
4. **Validate every value** against the field type. Any malformed entry
   leaves that track unclassified (it retries next pass) — the pipeline
   never stores garbage and never crashes on one bad row.
5. Upsert rows, record progress on the job, continue to the next chunk.
   Failures (timeout, HTTP ≥400) stop the job with a retryable state; the
   job manager resumes later. Rate limits / model flakiness are expected
   operating conditions, not errors to paper over.

### How the manager actually works (implementation notes)

- One daemon thread in the api process, ticking every 10s: step the oldest
  active job by one pass (200 tracks ≈ 8 LLM calls), then retry due error
  jobs (5-min backoff), then auto-scan. **One job steps at a time** — the
  model is a shared, flaky resource.
- **Auto-scan = the new-track hook.** "Needs work" (no current-revision row)
  already covers new classifiers, staleness, and freshly downloaded tracks,
  so one count query per (classifier, playlist) finds everything. No
  download-worker wiring is needed; new tracks get picked up within a tick.
- **Cancellation is cooperative AND a pause.** Cancel switches a job to
  `cancelling`; the loop honors it between passes. A `cancelled` job
  suppresses the auto-scan for its scope — cancelling means "stop, and stay
  stopped" (otherwise the scan would just re-enqueue it 10s later, making
  the button pointless). Manual "Classify all" re-enqueues over a pause,
  and a classifier revision bump lifts the pause (cancelled jobs are
  deleted) since a redefinition is new work.
- **Resumable by construction.** A step is bounded; progress is per-chunk
  commits plus the job row. Container restarts, LLM outages, and cancels all
  leave the scope simply "still needing work".
- Manual controls: `GET /api/classifier-jobs` (progress),
  `POST /api/classifier-jobs` (enqueue one scope or all playlists),
  `POST /api/classifier-jobs/{id}/cancel`, `DELETE` for terminal jobs.

### Chunk size
25 tracks ≈ 2–3 KB of prompt per chunk. 5,324 tracks ≈ 214 calls. At a few
seconds per call that's a background job of minutes to an hour — fine for a
nightly/batch system, absurd for a keystroke. This is the core reason the
search page itself never calls the model.

## 5. Search page (instant, 0% LLM)

- On playlist select: one GET of all tracks **with their classifications**
  (~1.5 MB for 5k tracks) + one GET of the classifier definitions.
- All filtering is **client-side and synchronous**: fuzzy text (title,
  artists, album), structured metadata (artist/album/title contains, year
  range, duration range, language), and one filter per classifier rendered
  by its field type (boolean → checkbox, number → min–max, string →
  contains/select, datetime → range). Result count + sortable paginated
  table update on every keystroke with no debounce needed.
- Tracks without a current value for a classifier render as *unclassified*
  (distinct from false — an unchecked boolean box means "classified false",
  and a separate "unclassified" affordance keeps the data honest).
- Scale note: client-side filtering is the right call up to ~tens of
  thousands of tracks. Beyond that, move the same filters to the server
  (FTS5 for the fuzzy box; the classifier values are already SQL-filterable
  via a JSON1 query) — the API shape is designed to allow that later.

### 5.1 Checking the reasoning

Two layers, because the cheap one is the faithful one:

- **Recorded reason (instant, no LLM).** Every classification stores the
  model's one-clause reason. It reaches the browser in the track payload
  (`classifications[classifier_id].reason`), shows in the cell tooltip, and
  opens in a per-track dialog when you click any classified AI cell:
  track, question, assigned value, recorded reason.
- **Detailed explanation (on-demand, 1 LLM call).** The dialog's "Explain in
detail" button calls `POST /api/classifiers/{id}/explain` with the track
  id. The endpoint re-asks the model — single track, tiny prompt, so far more
  robust than a 25-track batch — for a 2–5 sentence plain-language
  explanation citing the specific metadata, and returns it alongside the
  recorded reason. It is a fresh re-derivation, not the original thought
  process; the UI labels it "live LLM" to keep that honest. If the model is
  down the dialog shows the clean 502 error instead of failing the page.

## 6. Dynamic playlists (later phase)

A *saved search* (filter set + name) becomes a **generated playlist**:

- A cron (worker loop with a schedule) re-runs the saved search and diffs
  the track set against the managed Spotify playlist.
- Add new matches, remove tracks that no longer match. The playlist is
  always the materialization of its search — "update the list, and thus the
  playlist."
- Push to Spotify goes through the existing `create_spotify_playlist` /
  `POST /api/generate` plumbing (which already supports a search body,
  including classifier filters).

## 7. Legacy system (deprecated)

The original `is_mexican` / `is_latin_american` / `region` / `language` /
`classification_strategy` columns, `POST /playlists/{id}/classify`, the
Runs page, and the old hybrid engine implement the *old* model (one fixed
set of Latin/Mexican labels, query-time LLM). They are superseded by this
design:

- `language` is the one useful survivor (149 es rows in la crema); it stays
  as a static filter for now and could later be produced by a "language"
  classifier. The rest are frozen legacy data.
- The old columns are **not removed yet** (the Tracks page still displays
  them); a follow-up deletes the columns, the /classify endpoint, and the
  Runs tab once the classifier system is in daily use.
- The mock LLM (`backend/tests/mock_llm_server.py`) remains a dev tool for
  exercising classifier runs without the real model.

## 8. Phase status

**MVP (done):**
- Schema: `classifiers` + `track_classifications` (final shape, §9) — built
  now so nothing re-migrates later.
- Classifier API: list / create (with optional type inference) / update
  (revision bump) / delete; `POST /classifiers/{id}/run` executes a bounded
  chunked pass (limit + offset, only stale/unclassified) synchronously —
  the job manager's execution core, just without the manager yet.
- Classifications joined onto track outputs (GET tracks + /api/search), so
  the UI can render values and staleness.
- `/api/search` gains `classifier_filters` (id → value) so Generate and any
  server-side consumer can use AI fields too.
- First classifier seeded **directly in the database** (id=1):
  "music that is mexican, mexican-inspired, or by a mexican artist",
  boolean, revision 1 — per the plan, no management UI yet.
- A sample run over a handful of tracks proves the loop end to end; the
  search page shows the field as a checkbox and filters instantly.

**Job manager phase (done):**
- `classifier_jobs` table + the background manager (§4): auto-enqueue of new
  classifiers / staleness / new tracks, one-pass-at-a-time stepping,
  per-chunk resume, error backoff + auto-retry, cooperative cancel-as-pause.
- "AI Classifiers" page (app tab): add form (name + natural-language
  definition + optional field type, else 1st-pass LLM inference), classifier
  table with live stats (incl. true-count for booleans), "Classify all"
  manual enqueue, and a jobs table with live progress bars, errors, cancel
  and remove. Polls every 8s while open.
- Classifier list/create/update/delete API surfaced in the UI (the original
  "Manage AI classifiers" page, in this form).

**Remaining phases:**
- Dynamic generated playlists + cron sync (§6).
- Removal of legacy columns/endpoints/UI (§7).

## 9. Schema (as built)

```sql
CREATE TABLE classifiers (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,              -- UI label
    query        TEXT    NOT NULL,              -- natural-language definition
    field_type   TEXT,                          -- boolean|string|number|datetime (NULL until inferred)
    revision     INTEGER NOT NULL DEFAULT 1,    -- bump on query/type change
    created_at   DATETIME,
    updated_at   DATETIME
);

CREATE TABLE track_classifications (
    id                   INTEGER PRIMARY KEY,
    track_id             INTEGER NOT NULL REFERENCES tracks(id),
    classifier_id        INTEGER NOT NULL REFERENCES classifiers(id),
    classifier_revision  INTEGER NOT NULL,      -- stale if != classifiers.revision
    value                TEXT    NOT NULL,      -- JSON: true | 3.5 | "x" | "2024-01-01T00:00:00Z"
    reason               TEXT    DEFAULT '',    -- optional LLM rationale
    classified_at        DATETIME,
    UNIQUE (track_id, classifier_id)
);
CREATE INDEX ix_tc_classifier ON track_classifications(classifier_id, classifier_revision);

CREATE TABLE classifier_jobs (
    id              INTEGER PRIMARY KEY,
    classifier_id   INTEGER NOT NULL REFERENCES classifiers(id),
    playlist_id     INTEGER NOT NULL REFERENCES playlists(id),
    status          TEXT    NOT NULL DEFAULT 'queued',  -- queued|running|cancelling|done|error|cancelled
    total           INTEGER NOT NULL DEFAULT 0,        -- tracks needing work at enqueue
    done            INTEGER NOT NULL DEFAULT 0,
    failed          INTEGER NOT NULL DEFAULT 0,        -- bad rows (stay unclassified, retried)
    attempts        INTEGER NOT NULL DEFAULT 0,
    error           TEXT    DEFAULT '',
    retry_after     DATETIME,                          -- error -> queued after backoff
    created_at      DATETIME,
    started_at      DATETIME,
    finished_at     DATETIME
);
CREATE INDEX ix_cj_scope_status ON classifier_jobs(classifier_id, playlist_id, status);
```

## 10. Decisions & trade-offs worth remembering

- **Upsert, not history**: one current value per (track, classifier). The
  stale/re-run model makes history unnecessary for search; a history table
  can be added later if audit needs appear.
- **Derived staleness** (revision compare) beats a boolean flag: editing a
  classifier is O(1), and "classify the stale ones" is one query.
- **Strict schema in the request + validation on the way in**: the model is
  untrusted input. Anything that doesn't parse as the declared type is
  discarded and retried, never stored.
- **No query-time LLM, ever**: a search must never be slow, flaky, or
  cost-money per keystroke. AI fields are *data*, refreshed by batch.
- **Loose JSON values**: field types can evolve with the classifier's
  revision; the DB never has to migrate for a new classifier or a type
  change. The price (JSON1 queries instead of typed columns for
  server-side filtering) is acceptable at this scale.
