# Contract v1 — the product boundary (U34, ES-6.9)

Agent World is a renderer over five documents (four Worker reads and the pack), plus one signal (the Worker's event stream, which tells the adapter *when* to read again and is never itself rendered) and one question (the PA's `POST /ask`, since 2026-10-05). Everything it shows is read from the five documents or answered by the PA; nothing it does writes to any of them. The six JSON Schemas under `spec/` are the boundary between the Compass Worker, the packs and this fork — change them with a version, never quietly.

| Document | Schema | Producer | Consumer | Guard |
|---|---|---|---|---|
| `GET /ledger/scan?since=` — the Run Ledger window: `ops_run_events` rows and the `ops_skill_runs` rows for those runs | `spec/ledger-scan.v1.json` | `tellefsen-compass-mcp` (U10) | `server/harnesses/compass/supabase.mjs` → `fold.mjs` | `test/contract.test.mjs` validates `test/fixtures/m2b-ledger-scan.live.json` (a captured response) |
| `GET /world/substrate` — `WORLD_COMPANIES`, `AUTO_RUN_POLICY`, `DEAL_PIPELINE_STAGES`, Active `ops_clients`, `ops_skills`; v2 (live 2026-09-07) adds `version: 2`, `automations` (no status column), `connectors` (keyed by service, no status column) and `rollups` { `LAST_RUN_GOVERNANCE` null until the first sweep, `LAST_GATE_RECONCILIATION` } — the adapter branches on `version`, never on key presence | `spec/world-substrate.v1.json` | `tellefsen-compass-mcp` (U12W) | `server/harnesses/compass/substrate.mjs` → `zones.mjs`, `signals.mjs`, `still.mjs` | validates `test/fixtures/m2b-substrate.live.json` |
| `GET /world/spend?window=<1–365 \| all>[&include_test=1]` — every `ops_skill_runs` row in the window priced against `ops_config` `MODEL_PRICING` by method (`breakdown` from the terminal event's `payload.usage` — `run_completed`, or `run_failed` since Compass U5 — `flat` from the row's `tokens_in`/`tokens_out`, `unmetered`; an unresolved model `unpriced`), aggregated as `totals`, `by_client` (null → `internal`), `by_skill`, `by_client_skill`, `by_model`; `zztest-%` excluded unless `include_test=1` (U35W, live 2026-09-08); `estimates_version` and the optional `est` objects on `by_client` rows and `totals` — chat-usage estimates from `SPEND_ESTIMATES`, attributed by client name, never summed into a metered counter (U36W, live 2026-09-08) | `spec/world-spend.v1.json` | `tellefsen-compass-mcp` (U35W) | `server/harnesses/compass/spend.mjs` → the sidecar's `GET /spend` → `overlay/spend.mjs` (the fold through the pack's `roomForSkill`) | validates `test/fixtures/m2b-spend.live.json` |
| `GET /ledger/cost?days=1[&include_test=1]` — today's cost per town (U37, from Compass U5): every ended run's ledger row since 00:00 UTC, priced by the same code as `/world/spend`, grouped by `ops_skill_runs.town`, else the client (`town_source` says which) | `spec/ledger-cost.v1.json` | `tellefsen-compass-mcp` (U5, Engineering spine) | `server/harnesses/compass/spend.mjs` `today()` → the sidecar's `GET /spend/today` → the town card's `Today` line (Owner-only) | `test/contract.test.mjs` validates a synthetic answer produced by the Worker's own handler over ZZTEST rows, and `test/fixtures/ledger-cost.live.json` once `scripts/capture-contract.sh --cost-only` has made it (after U5 is deployed) |
| `GET /events/stream` — the ledger as server-sent events (approval layer P8, `src/lib/approval/stream.ts`): `id: <at>\|<event id>` · `event: ledger` · `data: {id, run_id, event_type, skill, client, at, parent_run_id, payload}`; `retry: 1000`; `: keepalive` at least every 15 s; each connection lives ~50 s and is resumed with `Last-Event-ID` (at most 24 h back); `?client=` filters, unused here (U7, 2026-10-04) | none — the adapter uses only *that* an event arrived (it drops the scan cache), never its fields, so there is nothing to validate; the next ledger scan is what the world shows | `tellefsen-compass-mcp` (approval layer P8; on main, live once the Worker is deployed from main) | `server/harnesses/compass/stream.mjs` → `compass.mjs` `nudge()` | `test/contract.test.mjs` allows the route and requires `cfg.streamUrl` requested verbatim from `stream.mjs`; `test/stream.test.mjs` speaks the frame format above against a local server |
| `POST /ask` — the PA (U16W, ES-4.6; Worker branch `compass-ask`, `docs/ask.md` there — not merged or deployed on 2026-10-05): `{question, context: {run_id?, client?, town?/zone?, milestone?, project?}}` with the events bearer, or `ASK_BEARER` when the Worker has one (this machine's copy: `WORLD_ASK_BEARER`) → 200 `{answer, based_on[], run_id, model, provider, usage, tokens_in, tokens_out, truncated, ledger, refused?, reason?, withheld?}` — `reason` is `annex_iii` or `english_only` (the Worker's checks read English only, 71fecb9); 400 a bad body (`{}` gives 400 even while the route is off — the liveness probe), 401, 405, 413, 429 `ask_budget_exceeded` with `Retry-After`, 502 `budget_unavailable` / `ledger_unavailable` / `substrate_unavailable` / `provider_failed` / `provider_timeout` / `out_of_time` (the reads left no time to call the model; nothing spent), 503 `ask_not_configured`. Every ask is a governed run of the Worker's own (skill `agent-world-pa`); the question and the answer never enter the ledger | `spec/ask.v1.json` (the 200 body; `$defs.error` every other status's) | `tellefsen-compass-mcp` (U16W) | the browser's PA panel (`overlay/pa.mjs`) → the sidecar's `POST /ask` (Owner only, local Origin, JSON ≤ 8 KB) → `server/harnesses/compass/ask.mjs`, which checks the body as the Worker will, adds the bearer and a 40 s deadline, and cuts the answer to the schema (ADR-0008) | `test/contract.test.mjs` cuts every case in `test/fixtures/ask.synthetic.json` (written from the branch: nothing to capture yet) and validates the result; `test/ask.test.mjs` runs the sidecar against a stand-in Worker |
| World Pack — `overlay/packs/<id>/pack.json`: skin, rooms (name, mirror, ring, spoke), nouns, lod, layout, figure ∈ {character, marker}, spend {show, window_days, currency, estimates} (U35, U36) | `spec/pack.v1.json` | this repo (a pack is presentation config; a client pack is M3) | `overlay/pack.mjs`, `server/harnesses/compass/pack.mjs`, `layout.mjs` | validates both shipped packs |

The adapter reads exactly five Worker routes — `/ledger/scan`, `/world/substrate`, `/world/spend` (ES-4.13, 2026-09-08), `/ledger/cost` (U37, 2026-10-04) and `/events/stream` (U7, 2026-10-04) — and asks one, `/ask` (U16, 2026-10-05): six in all, and `npm test` fails if `server/harnesses/compass.mjs` or `server/harnesses/compass/**` names any other (`/actions`, `/events`, `/ledger/<anything else>`). `/ask` is fetched only from `compass/ask.mjs`, to `cfg.askUrl` verbatim, and it is the adapter's one POST to the Worker: the invariant "the adapter never writes" allows exactly that line, because the ask's events and ledger row are the Worker's record of its own model call, not a write by the world. Every Worker URL is derived from `EVENTS_URL` in `compass/config.mjs` and nowhere else; the stream URL is requested as derived, with no query (the resume point travels in the `Last-Event-ID` header). `WORLD_STREAM=0` switches the stream off; the world then runs on its polls alone, as it did before U7. The seed script may `POST /events` and `DELETE /ledger/zztest`; it is a test fixture, not the adapter. Notion and Airtable are read with GETs and the one guarded data-source query (`compass/notion.mjs`, ids in `compass/notion-sources.mjs`).

Re-capture the three live responses after a Worker deploy with `scripts/capture-contract.sh` (`--substrate-only`, `--spend-only` for one of them) (bearer from `.env`; actors scrubbed, notes trimmed) and re-run `npm test`.

`GET /ledger/cost` has no live capture yet: Compass U5 is merged but not deployed, so `test/contract.test.mjs` validates `spec/ledger-cost.v1.json` against a synthetic answer made by the Worker's own handler, and its live check is skipped. Once U5 is deployed, run `scripts/capture-contract.sh --cost-only` once. It reads `GET /ledger/cost?days=1&include_test=1` into `test/fixtures/ledger-cost.live.json`. The repo is public, so the script keeps a value only at its known path in the contract, and only in its expected shape:
- `at` and `since` at the top must be ISO times; `by_town_day[].day` must be `YYYY-MM-DD`; `town_source` must be `town` or `client`; the counters must be numbers.
- `pricing_version` keeps its version and date (`0.2 · 2026-09-08`), not the free text after them.
- Every town other than `ZZTEST…` and `internal` becomes `town-1`, `town-2` …, the same stand-in in `by_town` and `by_town_day`.
- A value of the wrong shape at a known path is replaced by `redacted` and named on the terminal.
- A key the contract does not have, at any depth, refuses the capture. Nothing is written, and the path is named. The answer has changed, and a person decides what the new key may carry.
- Values are never printed. Run `npm test`: the live check then runs instead of skipping. Commit the fixture. A 404 means U5 is not live: the script says so and writes nothing. `test/capture.test.mjs` runs the mode against a local stand-in, never the real Worker. A captured response that no longer validates is a contract change: bump the schema's version and say so in `claude-progress.txt`.

Vocabulary: ES-6.9 says *nouns* and *mirror*; the pack files and `spec/pack.v1.json` carry them as `names` and `mirrors` (the keys the packs have used since U12). Same things, older names.

Rendering a `marker` figure is M3 work; the schema carries the value so a pack can declare it now.

**When Compass does not answer (U37).** Every read has a deadline that covers the whole answer, body included:
`WORLD_LEDGER_TIMEOUT_MS` (default 25 s) for the ledger scan, `WORLD_LEDGER_LONG_TIMEOUT_MS` (120 s) for the 30-day
background scan, and `WORLD_READ_TIMEOUT_MS` (10 s) for every other read, Notion and Airtable included.
- **Retries.** The ledger scan retries once on a network failure or a 502/503/504. It never retries a timeout or a
  4xx.
- **Answers in the wrong shape.** The ledger scan refuses an answer that is not `{ events, rows }`, and today's
  cost refuses one without `by_town`. The substrate and spend reads keep only the keys their schemas name.
- **While Compass is down.** The world keeps what it last saw. `GET /world` carries
  `signals.compass = {ok, downSince, lastGoodAt, error}`, failing while the ledger scan or the substrate is failing,
  and the strip draws it as a "Compass unavailable" pill. Polls that land during a ledger scan share it.

**The realtime nudge (U7).** The Worker streams the ledger as server-sent events (`GET /events/stream`, the events
bearer). The adapter listens and drops its scan cache on each event, so a poll inside the cache window reads the
ledger instead of a cached answer; an event that lands while a scan runs marks that scan's answer stale too. The cache
lasts 5 s from when the scan *finishes* (since 2026-10-04; it used to count from the start, which a 6–9 s scan had
already used up). The browser still polls
`/api/threads` every 15 s (upstream `src/`, unchanged), so the nudge makes the next poll fresh — it does not make the
page poll sooner. The stream never holds up a poll: it runs on its own, every wait has a deadline (the headers within
`WORLD_READ_TIMEOUT_MS`, then at most 45 s of silence), a message over 1 MB is cut off, and failures back off from 1 s
to 60 s (a refused bearer, or a Worker without the route, waits the 60 s at once). A stream that is down is not an
outage: the "Compass unavailable" pill reads the ledger scan and the substrate only.

**What `GET /world` (the side port) says about Compass.** Two records under `signals`, counts and times only — no
token, no run, no person:
- `signals.compass = {ok, downSince, lastGoodAt, error, failing, seen}` (U37). `ok` is null until a read has
  finished and false while the ledger scan or the substrate is failing. `failing` names the failing sources
  (`ledger`, `substrate`). `seen` gives, per source, when it last answered (null if never), so the pill's tooltip can
  say what on screen is current, old or never loaded. `downSince` is the earliest failure still standing.
  `lastGoodAt` is when the failing sources last answered.
- `signals.stream = {enabled, connected, state, since, lastEventAt, nudges, nudgedScans, reconnects, error}` (U7).
  `state` is one of off, connecting, open or waiting. `nudges` counts the events that dropped the cache.
  `nudgedScans` counts the scans that ran early because of one. A scan counts only if it starts before the dropped
  cache would have run out on its own, so a poll after natural expiry never counts. It stays 0 with `WORLD_STREAM=0`,
  and with a nudge that drops nothing.

**The PA's question (U16W wiring, 2026-10-05).** The browser never holds a bearer (ADR-0008). The PA panel posts
`{question, context}` to the sidecar's `POST /ask` on the loopback port; the sidecar answers only a viewer with the
`ask` capability (Owner), only with a local `Origin` and `Content-Type: application/json`, only for a body of at most
8 KB, and refuses all of those before the Worker is asked. `compass/ask.mjs` then checks the body the way the Worker
will (so a bad one never leaves the machine), forwards it with `WORLD_ASK_BEARER` (else the events bearer) under a
40 s deadline (`WORLD_ASK_TIMEOUT_MS`, above the Worker's 25 s on the model call), and passes the Worker's status back
with the body cut to `spec/ask.v1.json`: a key the schema does not name stays on the Worker, and since 2026-10-05
so does a value it does not allow — `ask.mjs` reads the schema file and checks every type, enum, pattern and
minimum in it (a value that does not fit is dropped when optional, nulled when nullable, and otherwise the answer is
refused as `bad_answer`). Every string passed on has the value of either bearer cut out (`[redacted]`). One question is in flight
at a time. The sidecar's own answers, beside the Worker's: 403 (not Owner, or no local Origin), 405, 409
`ask_in_flight`, 413, 415, 502 `worker_unreachable` / `bad_answer` (a 200 that is not an answer), 503
`world_not_configured` (no `/ask` URL or bearer on this machine), 504 `worker_timeout`. A log line carries the
status, the error code and the PA's own run id — never the question, the answer or the detail. Through the sidecar,
`{}` is the sidecar's own 400 and never reaches the Worker: the liveness probe is a curl to the Worker
(`VERIFICATION.md` V-U16W).
