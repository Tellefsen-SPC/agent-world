# ADR-0007 — The realtime nudge listens to the Worker's event stream, never Supabase

**Status:** Decided, to ratify · 2026-10-04 · U7 (SPEC.md §4.7, ES-1.10 amended), by the developer under delegated
authority

## Context
U7 was specified as a Supabase Realtime subscription (`postgres_changes` on `ops_run_events`) from this machine. That
needs a Supabase key, and the Lovable-managed project exposes none. That is the same wall that produced U10, so U7
was deferred. The Compass Worker now serves `GET /events/stream` (approval layer P8): it reads the ledger every 2 s
and streams new events as server-sent events over the events bearer, resumable with `Last-Event-ID`.

## Decision
- The adapter listens to `GET /events/stream` (`compass/stream.mjs`) and drops its scan cache on each event.
- It reconnects with backoff and `Last-Event-ID`.
- It is bounded: a header deadline, 45 s of silence, a 1 MB message cap, and backoff to 60 s.
- It never sits in front of a poll, and a stream that is down is not an outage.
- `WORLD_STREAM=0` turns it off. The URL is derived from `EVENTS_URL` and is the contract's fifth route.
- The scan cache counts from when the scan finishes, so the cache serves polls and the nudge is what refreshes
  it early.
- `GET /world` carries `signals.stream`, with `nudgedScans` as the count of what only the nudge causes.

## Consequences
- The next poll after an event reads the ledger fresh. The page still polls every 15 s (upstream `src/`), so the
  nudge makes the next poll fresh rather than sooner.
- M0's "Realtime delivery to a subscriber" check is not closed by this path; the Worker polls the table.
- The live check (V-U7) waits for the Worker to be deployed from main.
