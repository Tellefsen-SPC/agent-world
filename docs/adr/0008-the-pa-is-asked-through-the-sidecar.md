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
  Owner preset, the only one that has it), a local `Origin` (the same rule as its other state-changing route),
  `Content-Type: application/json` (so a cross-site form cannot post without a preflight) and a body of at most
  8 KB. It fails closed: no viewer, or one it cannot resolve, is refused.
- `compass/ask.mjs` holds the bearer (`WORLD_ASK_BEARER`, else the events bearer). It checks the body as the Worker
  does, so a bad one never leaves the machine. It forwards the body under a 40 s deadline, longer than the Worker's
  own 25 s on the model call, so the Worker's `provider_timeout` arrives first. It passes the Worker's status back
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
