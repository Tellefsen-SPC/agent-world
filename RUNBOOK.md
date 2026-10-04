# Agent World — runbook

For the person who runs the world, not the person who changes its code. Every command below is typed in a
terminal, in the repo folder, one at a time. Nothing here writes to Compass, Notion or Airtable: the world only
reads them. The one thing it writes is the map layout, in `data/colony*.json` on this machine.

> **The repo is public** (checked 2026-10-04). The decision is to make it private; that is an owner action in
> GitHub → Settings → General → Danger Zone → Change visibility, and it has not been done yet. Until it is, everything
> committed is published, including the captured test fixtures under `test/fixtures/` (client names and spend
> figures). Don't commit anything you would not post.

## 1. Run the world

You need Node 20 or newer (CI uses 22) and a `.env` file. Copy it once from the template, then fill in the tokens.
Never commit `.env`; it is already ignored.

```
cp .env.example .env
```

Each session, first check that everything installs, builds and passes:

```
./init.sh
```

It ends with `smoke ok`. Then start the world:

```
./dev.sh
```

Open http://127.0.0.1:5274. Stop it with Ctrl-C in that terminal.

- Use `./dev.sh`, not `npm run dev`. Plain `npm run dev` does not read `.env`, so the world comes up empty.
- To see what the adapter is doing, start it with its log on: `DEBUG=world ./dev.sh`.
- To check the world's own view of Compass, while it runs:

```
curl -s 127.0.0.1:5275/world | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const w=JSON.parse(s);console.log({compass:w.signals.compass,realtime:w.signals.realtime})})'
```

`compass.ok: true` means the ledger and the client map are answering. `realtime.state: 'open'` means the live
nudge is connected (section 2, `WORLD_STREAM`).

## 2. Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `EVENTS_URL` | — (required) | The Compass Worker's address, ending in `/events`. Every Compass read is worked out from it. |
| `EVENTS_BEARER_TOKEN` | — (required, secret) | The Worker's events token. Reads the ledger, the client map, spend and the live stream. |
| `NOTION_TOKEN` | — (secret) | Reads milestones, Decisions and the room panels' Notion sources. |
| `AIRTABLE_TOKEN` | — (secret) | Reads Pending Approval, the pipeline and finance. |
| `AIRTABLE_BASE_ID` | `appixWl8C3bogLsvp` | The HQ base. |
| `CLAUDE_PROJECT_URL` | — | Where Open goes for a chat run. |
| `WORLD_VIEWER_PRESET` | `owner` | Who is looking: `owner`, `operator`, `viewer`, `client` or `prime`. Only `owner` sees spend, and only `owner` may save plot moves on planets other than home. |
| `WORLD_WINDOW_DAYS` | `14` | How far back the ledger is read. |
| `WORLD_RUNNING_TTL_HOURS` | `2` | A run with no activity for this long stops counting as running. |
| `WORLD_TENANT` | `tellefsen` | The tenant name the viewer carries. |
| `WORLD_OVERLAY_PORT` | `5275` | The adapter's side port (planets, room panels, spend). `0` turns it off: home planet only, no panels. |
| `WORLD_LEDGER_TIMEOUT_MS` | `25000` | How long the ledger read may take, answer included. A normal day takes 6–9 s. Past this, the "Compass unavailable" pill shows. |
| `WORLD_LEDGER_LONG_TIMEOUT_MS` | `120000` | The same for the 30-day background read (the silent-skills list). It never holds up the screen. |
| `WORLD_READ_TIMEOUT_MS` | `10000` | The same for every other read: the client map, spend, Notion and Airtable. |
| `WORLD_STREAM` | on | The live nudge from the Worker's event stream. `0` turns it off; the world then refreshes on its polls alone, as before. |
| `NOTION_DS_CONTENT`, `NOTION_DS_RESEARCH`, `NOTION_DS_DELIVERABLES`, `NOTION_DS_INTEGRATIONS`, `NOTION_DS_FIELD_MAPPINGS`, `NOTION_DS_SYSTEM_HEALTH`, `NOTION_DS_TASKS` | unset | Notion data-source ids for the room panels. A panel whose id is missing says `SKIPPED:ENV — set <name>`. |
| `PIPELINE_HOT_VIEW` | `Active pipeline` | The Airtable view the strategy room lists. |
| `DEBUG` | unset | `world` prints the adapter's log. |
| `PORT` | `5274` | The world's port under `npm start`. |
| `BOT_CROSSING_HOST` | `127.0.0.1` | Where `npm start` listens. Keep it on this machine. |
| `BOT_CROSSING_DATA` | `data/` | Where the layout files live. |
| `ZZTEST_PA_URL`, `ZZTEST_PROJECT_ID` | — | Used by the test-data script `scripts/zztest-seed.sh`. |
| `AGENT_WORLD_PROJECT_ID` | — | Puts this repo's own build sessions on the Agent World plot. |

A changed setting takes effect when the world is restarted (Ctrl-C, then `./dev.sh`).

## 3. The "Compass unavailable" pill

The strip at the top shows a red pill, **Compass unavailable · since HH:MM**, when the ledger read or the client
map (the substrate) has failed or run past its deadline. Hover it to see what on screen is still current:

| Tooltip says | Meaning |
|---|---|
| "The runs are as the world last saw them, at HH:MM." | The ledger is not answering; the figures and `?`s are from that time. |
| "The runs are current. The towns are as of HH:MM." | The ledger answers; the client map does not. A new client may be missing. |
| "…the map of clients and towns has not loaded yet, so towns may be missing." | The client map has never answered since the world started. |
| "Nothing has loaded yet, so the world is empty." | Neither has answered since the world started. |

The world keeps trying on its own, and nothing is lost. The pill clears on the first good answer, within a poll
(about 15 s). What to do:

1. Wait one minute. A Worker that is busy for a moment clears by itself.
2. Load the tokens into your terminal, then ask the Worker directly:

```
set -a; . ./.env; set +a
```

```
curl -s -o /dev/null -m 30 -w '%{http_code} in %{time_total}s\n' -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" "${EVENTS_URL%/events}/ledger/scan?since=$(date -u +%Y-%m-%dT00:00:00Z)"
```

3. Read the answer:
   - **200 in a few seconds**: Compass is fine now; the pill clears on the next poll.
   - **401**: the token is wrong or was rotated. Put the Worker's current `EVENTS_BEARER_TOKEN` in `.env` and restart.
   - **404**: `EVENTS_URL` is wrong. It must end in `/events`.
   - **5xx, or `000` after 30 s**: Compass itself is in trouble. Nothing to fix on this machine. Tell Christoffer;
     the world will catch up by itself when Compass is back.

The live-stream nudge never raises this pill. A stream that is down only means the world refreshes on its polls.

## 4. Re-capture the contract fixtures

The tests check the world against copies of real Worker answers in `test/fixtures/`. After a Worker deploy that
changes what a route answers, refresh them. This reads the real Worker with the token in `.env` (reads only).

```
scripts/capture-contract.sh
```

That refreshes the client map, spend and a ledger sample. For one of them only, add `--substrate-only` or
`--spend-only`. For today's cost per town, run this once Compass U5 is deployed:

```
scripts/capture-contract.sh --cost-only
```

Until then that command says "is Compass U5 deployed?" and writes nothing. It replaces every town name except the
ZZTEST ones with `town-1`, `town-2` …, and it warns if Compass sent something it does not recognise. Then:

```
npm test
```

- If it passes, look at the changed fixture files before committing (the repo is public).
- If it fails, Compass changed what it answers. That is a contract change: someone who changes code must bump the
  schema version in `spec/` and note it in `claude-progress.txt`. Details are in `docs/CONTRACT.md`.

## 5. What must never be touched

- **The substrate.** No writes to Compass, Notion or Airtable, ever: no ledger rows, no `gate_passed`, no archive
  flags, no edits to Pending Approval rows, Decisions or Milestones. The world only reads; you tap on the surface
  itself. The one exception is test data: `scripts/zztest-seed.sh --clean` deletes `zztest-*` runs through the
  Worker. It is never run against anything else.
- **Upstream code.** `src/`, `server/scan.mjs`, `server/api.mjs` and `server/harnesses/claude-code.mjs` stay exactly
  as in Bot Crossing. `npm test` and CI fail otherwise.
- **Secrets.** Tokens live only in `.env`. They never go in git, logs, screenshots, tickets or the knowledge base.
- **People.** The world shows places and runs, never a person's performance (Annex III). There is no per-person
  view, and none is to be added.
- **Test data.** Only `ZZTEST` names and `zztest-` skills, never a real client's rows.
- **Production.** `main` is production: changes land through pull requests, and only Christoffer marks a unit
  Verified.

## 6. When something goes wrong

| Symptom | Check | Fix |
|---|---|---|
| The world opens empty, with no towns and no runs | Did you start it with `npm run dev`? | Stop it and use `./dev.sh`. |
| `./init.sh` stops with "compass not detected" | Is `EVENTS_URL` or `EVENTS_BEARER_TOKEN` empty in `.env`? | Fill both in, run `./init.sh` again. |
| Red "Compass unavailable" pill | Section 3 | Section 3. |
| Only the home planet, no room panels, no spend | The terminal says `overlay api on 127.0.0.1:5275 — … EADDRINUSE`: another copy of the world holds the port | Close the other copy (or its terminal), restart. |
| A room panel reads `SKIPPED:ENV — set NOTION_DS_…` | That id is missing from `.env` | Add the data-source id, restart. |
| A panel reads `… is set but unreadable: notion 404` | The Notion database is not shared with the integration | In Notion, share the database with "Tellefsen - Agent world". |
| Progress bars stuck at 5 % | The log warns `milestone progress unavailable … 404` | Share the Projects database with "Tellefsen - Agent world". |
| A `?` stays after you approved | Wait one poll (15 s). Is the gate a Claude Code permission prompt? Those clear only when the session answers. Does the terminal say `cross-check unavailable`? | That is a missing or expired `AIRTABLE_TOKEN` or `NOTION_TOKEN`: renew it in `.env`, restart. |
| No spend line on town cards | `curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:5275/spend`: **403** means the viewer is not Owner | Set `WORLD_VIEWER_PRESET=owner`, restart. A 200 with no line: the pack is `neutral`, which never shows spend. |
| The town card reads `Today · unavailable` | Compass U5 (`GET /ledger/cost`) is not deployed, is failing, or last answered on an earlier day (UTC) | Nothing to fix here; it fills in once U5 answers. |
| A plot moved on another planet (not home) is back where it was after a reload | The viewer is not Owner: the side port refuses its layout writes (403) | Set `WORLD_VIEWER_PRESET=owner` on the machine that arranges the map. (The home planet's layout is saved by Bot Crossing's own API, which does not know the viewer.) |
| Terminal warns `realtime: stream unavailable — the Worker has no GET /events/stream (404)` | The Worker on Cloudflare is older than its `main` | Harmless: the world runs on its polls. Set `WORLD_STREAM=0` to quiet it until the Worker is deployed. |
| Terminal warns `realtime: stream unavailable — the Worker refused the events bearer (401)` | The token is wrong | As the 401 in section 3. |
| `npm test` fails: "no upstream/main" | The `upstream` remote is missing | `git remote add upstream https://github.com/jarrenrocks/bot-crossing`, then `git fetch upstream`. |
| `npm test` or CI fails: "src/ differs from upstream" or "never-touch files differ" | Someone edited upstream code | Undo that edit; the change belongs in `overlay/` or `server/harnesses/compass/`. |
| CI is red, but `npm test` passes on your machine | Open the failing step in GitHub → Actions | If it is the upstream fetch, re-run the job. Anything else is a real failure. |

## Where things are

- What the world is and must be: `SPEC.md`. How each unit is checked by a person: `VERIFICATION.md`.
- What it reads, route by route: `docs/CONTRACT.md`. What M3 (hosted, several people) needs: `docs/multiplayer.md`.
- The standing decisions and why: `docs/adr/`.
- Rules for anyone changing code here: `CLAUDE.md`.
