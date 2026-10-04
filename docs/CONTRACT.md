# Contract v1 — the product boundary (U34, ES-6.9)

Agent World is a renderer over five documents (four Worker reads and the pack). Everything it shows is read from them; nothing it does writes to them. The five JSON Schemas under `spec/` are the boundary between the Compass Worker, the packs and this fork — change them with a version, never quietly.

| Document | Schema | Producer | Consumer | Guard |
|---|---|---|---|---|
| `GET /ledger/scan?since=` — the Run Ledger window: `ops_run_events` rows and the `ops_skill_runs` rows for those runs | `spec/ledger-scan.v1.json` | `tellefsen-compass-mcp` (U10) | `server/harnesses/compass/supabase.mjs` → `fold.mjs` | `test/contract.test.mjs` validates `test/fixtures/m2b-ledger-scan.live.json` (a captured response) |
| `GET /world/substrate` — `WORLD_COMPANIES`, `AUTO_RUN_POLICY`, `DEAL_PIPELINE_STAGES`, Active `ops_clients`, `ops_skills`; v2 (live 2026-09-07) adds `version: 2`, `automations` (no status column), `connectors` (keyed by service, no status column) and `rollups` { `LAST_RUN_GOVERNANCE` null until the first sweep, `LAST_GATE_RECONCILIATION` } — the adapter branches on `version`, never on key presence | `spec/world-substrate.v1.json` | `tellefsen-compass-mcp` (U12W) | `server/harnesses/compass/substrate.mjs` → `zones.mjs`, `signals.mjs`, `still.mjs` | validates `test/fixtures/m2b-substrate.live.json` |
| `GET /world/spend?window=<1–365 \| all>[&include_test=1]` — every `ops_skill_runs` row in the window priced against `ops_config` `MODEL_PRICING` by method (`breakdown` from the terminal event's `payload.usage` — `run_completed`, or `run_failed` since Compass U5 — `flat` from the row's `tokens_in`/`tokens_out`, `unmetered`; an unresolved model `unpriced`), aggregated as `totals`, `by_client` (null → `internal`), `by_skill`, `by_client_skill`, `by_model`; `zztest-%` excluded unless `include_test=1` (U35W, live 2026-09-08); `estimates_version` and the optional `est` objects on `by_client` rows and `totals` — chat-usage estimates from `SPEND_ESTIMATES`, attributed by client name, never summed into a metered counter (U36W, live 2026-09-08) | `spec/world-spend.v1.json` | `tellefsen-compass-mcp` (U35W) | `server/harnesses/compass/spend.mjs` → the sidecar's `GET /spend` → `overlay/spend.mjs` (the fold through the pack's `roomForSkill`) | validates `test/fixtures/m2b-spend.live.json` |
| `GET /ledger/cost?days=1[&include_test=1]` — today's cost per town (U37, from Compass U5): every ended run's ledger row since 00:00 UTC, priced by the same code as `/world/spend`, grouped by `ops_skill_runs.town`, else the client (`town_source` says which) | `spec/ledger-cost.v1.json` | `tellefsen-compass-mcp` (U5, Engineering spine) | `server/harnesses/compass/spend.mjs` `today()` → the sidecar's `GET /spend/today` → the town card's `Today` line (Owner-only) | `test/contract.test.mjs` validates a synthetic answer produced by the Worker's own handler over ZZTEST rows; re-capture live once U5 is deployed |
| World Pack — `overlay/packs/<id>/pack.json`: skin, rooms (name, mirror, ring, spoke), nouns, lod, layout, figure ∈ {character, marker}, spend {show, window_days, currency, estimates} (U35, U36) | `spec/pack.v1.json` | this repo (a pack is presentation config; a client pack is M3) | `overlay/pack.mjs`, `server/harnesses/compass/pack.mjs`, `layout.mjs` | validates both shipped packs |

The adapter reads exactly four Worker routes — `/ledger/scan`, `/world/substrate`, `/world/spend` (ES-4.13, 2026-09-08) and `/ledger/cost` (U37, 2026-10-04) — and `npm test` fails if `server/harnesses/compass.mjs` or `server/harnesses/compass/**` names any other (`/ask`, `/actions`, `/events`, `/ledger/<anything else>`). The seed script may `POST /events` and `DELETE /ledger/zztest`; it is a test fixture, not the adapter. Notion and Airtable are read with GETs and the one guarded data-source query (`compass/notion.mjs`, ids in `compass/notion-sources.mjs`).

Re-capture the three live responses after a Worker deploy with `scripts/capture-contract.sh` (`--substrate-only`, `--spend-only` for one of them) (bearer from `.env`; actors scrubbed, notes trimmed) and re-run `npm test`. A captured response that no longer validates is a contract change: bump the schema's version and say so in `claude-progress.txt`.

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
