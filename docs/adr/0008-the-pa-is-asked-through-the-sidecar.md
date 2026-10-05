# ADR-0008 — The PA is asked through the sidecar; the browser never holds a bearer

**Status:** Decided, to ratify · 2026-10-05 · U16W wiring and U16 (by the developer under delegated authority)

## Context
ES-4.6 puts the PA behind the Worker's `POST /ask`, authorised with the events bearer (or the Worker's own
`ASK_BEARER`). Something has to send that bearer. The panel lives in the browser, and the easy path is for the page
to call the Worker itself. But the events bearer is the key to the whole ledger: it reads every run (`/ledger/scan`),
the substrate and spend, and it is the token that **writes** `ops_run_events` through `POST /events`. A token in
page JavaScript can be read by any script on the page, by the browser's dev tools, by an extension, and, once the
world is hosted (M3), by everyone who opens it. Today every other Worker call is made on the server, and the browser
holds names and numbers only (`overlay/zones.mjs`: "No token ever reaches this file").

## Decision
- The panel posts `{question, context}` to the sidecar's `POST /ask` (`compass/overlay-api.mjs`), on loopback, never
  to the Worker.
- The sidecar decides who may ask before anything else happens. It needs the `ask` capability (`viewer.mjs`: the
  Owner preset, the only one that has it), the world's own page as `Origin` — a loopback host and the page's port,
  stricter than its other routes' "any local origin", because every question spends tokens (2026-10-05, review),
  `Content-Type: application/json` (so a cross-site form cannot post without a preflight) and a body of at most
  8 KB. It fails closed: no viewer, or one it cannot resolve, is refused.
- `compass/ask.mjs` holds the bearer (`WORLD_ASK_BEARER`, else the events bearer). It checks the body as the Worker
  does, so a bad one never leaves the machine. It forwards the body under a 50 s deadline (at most 55 s), longer
  than the Worker's own 28 s after an ask starts, so the Worker's 502s arrive first, and shorter than the page's 60 s,
  so the page hears the side port's 504. A timeout never claims the question stayed here: the ask may still be
  running on the Worker. It passes the Worker's status back
  with the body cut to `spec/ask.v1.json`. It allows one question in flight. It logs the status, the error code and
  the PA's own run id, never the question or the answer.
- The model call stays on the Worker. The fork still names no model endpoint (`npm test`), and the world still
  writes nothing. The ask's `run_started`, `run_completed` and ledger row are the Worker's record of its own call.
  So the invariant "the adapter never writes" allows exactly one POST: the question, to `cfg.askUrl`, from
  `compass/ask.mjs` (`test/invariants.test.mjs`).

## Consequences
- No bearer is ever in the browser, and the bearer can be rotated without touching the page.
- The PA panel is Owner-only on the server, so M3 needs no special case for it: a client grant is already refused.
- The sidecar is now the one place the world reaches the PA. It is in the contract guard as the sixth Worker route
  (`test/contract.test.mjs`), and only `compass/ask.mjs` may fetch it.
- A liveness probe through the sidecar proves nothing about the Worker. `{}` is the sidecar's own 400, so the
  dead-route check (`{}` → 400, 404 when the route is missing) is a curl straight to the Worker (V-U16W).
- One question at a time is per process. A second question while one is out gets a 409, not a queue.

## Residual risk: Annex III (review, 2026-10-05)
- The panel shows the Worker's answer verbatim. The Worker's own answer check misses some judgements of people by
  design: its `docs/ask.md`, "What it still misses", names "Ann has the most open gates", "Ann took 9 hours on
  average", names in lower case, and a judgement with no person word ("the first one is lazier"). Those can reach
  the panel.
- The world adds one backstop. The sidecar withholds an answer whose text or refs name someone the last ledger scan
  names as an actor, on any event, taps included. The panel then shows **Withheld: it named a person**, with no text
  and no refs, and keeps only the PA's run id, model and counts. Rules, `compass/ask.mjs`:
  - exact word or phrase matches only, never part of a word;
  - a single plain word only where it is capitalised, so an actor "will" does not withhold every "will";
  - non-person actors are ignored (decided 2026-10-05, confirmation review). That means the fixed system actors
    (`world`, `cowork`, `worker`, `cron`, `coordinator`, `n8n`, `zapier`, `claude`, `hook`, `session_hook`, `system`,
    `actor` — the live capture's scrubbed placeholder — and the rest of `SYSTEM_ACTORS` in `compass/ask.mjs`),
    anything starting `zztest`, and any value equal to a name the world already knows: a skill or one of its steps, a
    trigger value, a client or town, a company or its key, a room, the campus. So "The Cowork job…", "Agent World
    shows…" and "ZZTEST Town has 2 open gates" pass. Before this, the last two, "Actor fields…" and "the
    Coordinator…" were withheld.
- The names stay on the server, in memory with the scan. The page holds no actor and nothing logs one.
- **It withholds answers that name Christoffer, and that is intended.** His handle is an actor in the ledger (the
  taps he makes), so "Alpha waits on Christoffer's approval." is withheld, and the panel shows "Withheld: it named a
  person". The reason: the rule is that the PA never names a person. An exception for the Owner would be a list of
  people the PA may name, and that list would grow. The same answer said by place ("Alpha waits on the ZZTEST
  Pending Approval row") goes through, and the in-tray already shows whose surface a gate is on. If Christoffer
  wants his own name allowed, that is a decision for him to take knowingly, not a default.
- It misses:
  - names outside the 14-day window, or never in the ledger;
  - a first name alone when the actor is a full name;
  - a lower-case name;
  - a judgement with no name at all.
  It errs toward withholding: "Will this run finish?" is withheld when someone called Will has acted. It fails open
  when there is no scan yet: the Worker's own check then stands alone.
- Using actor values this way is new. CLAUDE.md said `actor` draws an avatar and nothing else. This is a protective
  use, a deny-list that never ranks or shows anyone, and it is noted there, to ratify.
