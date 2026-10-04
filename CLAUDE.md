# Agent World — Bot Crossing fork with a Compass adapter

The Build Pack is canonical for the unit table and the verifier's checks: Notion **🔧 Build Pack — Agent World** (child of the Project page). This repo is canonical for code content: `SPEC.md`, `FEATURES.md` / `feature_list.json`, `VERIFICATION.md`.

## What this is
A local mirror of Tellefsen's Run Ledger: every governed skill run is an astronaut on its client's plot; a run waiting on a human holds a `?`; N flies to the next one. A fork of jarrenrocks/bot-crossing (MIT). Outcome and end-states: `SPEC.md`.

## Ownership
Tellefsen SPC internal product. Repo `Tellefsen-SPC/agent-world` (moved from `Christoffer-Tellefsen/agent-world`, which redirects). **It is public** (checked 2026-10-04); the decision is to make it private (2026-10-04, to ratify). Changing visibility is an owner action in GitHub's settings and has not been done — until it is, treat everything committed here as published. Remote `upstream` = https://github.com/jarrenrocks/bot-crossing; the fork is built on 87ec837, and `npm test` diffs against `git merge-base HEAD upstream/main`. Owner and only user until M3: Christoffer.

## System of record — who writes what
- `ops_run_events`, `ops_skill_runs` (Supabase, Compass): written by skills, Cowork jobs, the Worker `POST /events` and the hooks in `.claude/hooks/`. **Read only here.**
- 🎯 Engagement Milestones and Decisions (Notion), Pending Approval (Airtable): **read only here.**
- `data/colony.json`: the world's only write — plots (layout) and render settings. Nothing else is state.
- The adapter never writes to the substrate: not a row, not an archive flag. A design that needs the world to store or write something stops and logs a Decision (`project-log`); it is not built.

## Layout and the seam
- `server/harnesses/compass.mjs` is the adapter entry; helpers live in `server/harnesses/compass/`. `index.mjs` registers `[compass]` only; `claude-code.mjs` stays in the tree, unregistered and unmodified.
- `src/` is byte-identical to upstream — `npm test` fails otherwise. A change `src/` needs is an upstream PR, then a rebase; never a fork-local edit.
- `server/scan.mjs` and `server/api.mjs` are not edited (the harness README's contract).
- U9 (the Worker write-gate) is built in the `tellefsen-compass-mcp` repo, never here; this repo reads the ledger only.
- Client-side additions live in `overlay/`, mounted from `index.html`, reading `window.botCrossing` (`threads`, `colony.astronauts.selected`, `hud`, `poll`). U11 (the selection panel) is the first; M2 adds the PA panel, sound, voice, in-tray. `index.html` is ours to edit for the mount line only.

## Naming
Harness `id: 'compass'`, `name: 'Compass'`. `thread.id` = `run_id`. Zone (`thread.project`) = `ops_clients.name`, or `Tellefsen HQ` for runs with no client. Test runs: skill `zztest-*`, client `ZZTEST Client`. Secrets only in `.env` (gitignored); never in code, logs or commits.

## Annex III
This system never autonomously assigns work to, or evaluates/scores, a named individual. Anything that routes, ranks, or scores people writes a recommendation; a human commits. This applies to every automation, agent, workflow, and model-driven component, now and in later phases.

Here that means: `actor` draws an avatar and nothing else; `human_edit_level`, tokens and model are never shown or aggregated per person; no per-person view exists on any surface.

## Never touch
- `src/**`, `server/scan.mjs`, `server/api.mjs`, `server/harnesses/claude-code.mjs`.
- The ledger tables — the world never writes or deletes. ZZTEST cleanup is `scripts/zztest-seed.sh --clean`, a test fixture, not the adapter: it calls the Worker's `DELETE /ledger/zztest`, which removes `skill LIKE 'zztest-%'` rows and nothing else (Decision 2026-09-06). `scripts/zztest-cleanup.sql` was removed on 2026-09-06 (8d6ceba); it assumed a Supabase SQL editor this Lovable-managed project does not have.
- Production Pending Approval rows, Decisions and Milestones — read only; tests use ZZTEST rows.
- Any model API. The world burns zero tokens; `npm test` fails on a model endpoint anywhere outside `node_modules`.

## Commands
- `./init.sh` — install, build, syntax-check the adapter, `npm test`, start the server, smoke `/api/harnesses` (compass detected) and `/api/threads`. Run it first, every session.
- `./dev.sh` — the world at http://127.0.0.1:5274 (loads `.env`, then `npm run dev`). **Plain `npm run dev` does not read `.env` and shows an empty world** — Vite never passes `.env` to the server-side API. `npm test` — invariants + adapter fixture tests.
- `scripts/zztest-seed.sh` — posts the standing ZZTEST runs to `/events` (needs `EVENTS_BEARER_TOKEN` and `ZZTEST_PA_URL`). `scripts/reset-view.sh` — clears this browser's local hide list (A key) so every run shows again.

## Session rules
1. Read `claude-progress.txt`, `git log --oneline -20`, `feature_list.json`; run `./init.sh` before changing anything.
2. One feature per session — the first `passes: false`. Explore → plan → implement → verify → commit. Never start the next feature past a failing check.
3. `feature_list.json`: change `passes` only. Never remove or weaken a feature or its steps.
4. `npm test` green plus the feature's own steps let you mark a unit **Built**. Only Christoffer marks **Verified**, from `VERIFICATION.md`, in the Notion unit table. Never self-declare.
5. Commit naming the unit (`U3: fold events into runs`), update `claude-progress.txt`, leave `main` clean and runnable.
6. This session is a governed run: the hooks post its events; `run_id` is in `.claude/run_id`. At the end, write the `ops_skill_runs` row through the Compass MCP per `SKILL_RUN_LEDGER.write_protocol` — skill `agent-world-build`, run_class `B_judge`, trigger `claude_code`, `human_edit_level` from Christoffer's one tap — and end with `📒 agent-world-build · <outcome> · gates <n> · edit <level> · run <run_id>`. Usage (U35, ES-4.13): the SessionEnd hook posts `run_completed` with `usage {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, model, source: "transcript"}` summed from the session transcript (`.claude/hooks/ledger.sh usage <transcript>` prints the same object); on the row, `tokens_in` = input + cache_creation + cache_read, `tokens_out` = output_tokens, `model` = usage.model — when the hook posted usage, else null.

## Change control
Design detail → decide in-session, note it in `claude-progress.txt`, propose a 🧠 Decision if material. Scope (anything not in `SPEC.md`) → stop; it routes through a build-kickoff refresh, never into this file. This file changes only with Christoffer; changes are dated below.

## Definition of done
Unit Built → its check passes in the verifier's hands → Verified. All M1 units Verified → M1 regression pass → M1 Done (`milestone-close`). All milestones Done → acceptance. The builder never self-declares.

---
Changes: 2026-09-06 · v1 · written by build-kickoff v1.3. · 2026-09-08 · session rule 6 gains the usage block (U35, Prompt D from Christoffer). · 2026-10-04 · factual fixes: the repo's name and visibility (public; private is the decision, an owner action), the fork base checked by merge-base, the ZZTEST cleanup is `zztest-seed.sh --clean` (the .sql is gone) — by the developer under delegated authority, to ratify.
