# ADR-0003 — Every read has a deadline, and the deadline covers the body

**Status:** Decided, to ratify · 2026-10-04 · U37, the Engineering spine's U8 (by the developer under delegated authority)

## Context
Before U37, a Compass that answered slowly held the scan for as long as it liked. A Worker that sent its headers and
then stalled was an unbounded hang, and the world went stale with nothing on screen to say so. A 200 whose body
failed was read as an empty success: the world emptied and called Compass healthy.

## Decision
Every read goes through `withTimeout` (`compass/health.mjs`), whose deadline covers the whole answer, body
included:
- the ledger scan: `WORLD_LEDGER_TIMEOUT_MS`, 25 s;
- the 30-day background scan: `WORLD_LEDGER_LONG_TIMEOUT_MS`, 120 s;
- everything else (substrate, spend, Notion, Airtable): `WORLD_READ_TIMEOUT_MS`, 10 s.

The ledger scan retries once on a network failure or a 502/503/504, never on a timeout or a 4xx. It refuses an
answer that is not `{ events, rows }`. A 200 whose body fails is an error, never an empty success.

## Consequences
- A dead or hanging Compass puts the "Compass unavailable" pill up within the deadline, and the world keeps what it
  last saw.
- The realtime stream follows the same rule in its own form: its headers within the read deadline, then at most
  45 s of silence (ADR-0007).
