# ADR-0004 — One scan at a time, health per source, one read in flight per cache key

**Status:** Decided, to ratify · 2026-10-04 · U37 (the scan, health) and the ops batch (every other cache), by the
developer under delegated authority

## Context
A live ledger scan takes 6–9 s. With pages polling every 15 s, overlapping scans read Compass several times over. A
slow scan could also finish after a newer good one and report an outage that was already over. The other caches
(substrate, spend, the 5-minute panels) let every caller that found them cold or expired start its own read: ten
viewers meant ten reads of Notion.

## Decision
- **One scan at a time.** Polls that land during a scan share it (`compass.mjs` `scanThreads`).
- **Health per source.** The ledger and the substrate are tracked separately (`createHealth`). `signals.compass`
  says which is failing, since when, and what on screen is current, old or never loaded.
- **One read in flight per cache key.** The substrate, spend and today's cost, `surfaces.stale()` (the 5-minute
  panels), milestone progress, and the steering panels the rooms read each hold the promise of the read in flight.
  - On a **cold** key, every caller waits for that one read and gets its answer, never a fallback.
  - On an **expired** key, the readers differ. The substrate, spend, milestone and steering readers make their
    callers wait for the one refresh. `stale()` (stale-while-revalidate, for the request lists and room panels)
    hands every caller the old value at once and refreshes once behind them, so its callers see the new answer on
    their next call. A failed refresh is retried after 30 s, and its key names the error.

## Consequences
- A cache expiring under many viewers is one read of Compass, Notion or Airtable (`test/single-flight.test.mjs`
  counts them).
- A slow read slows every caller waiting on it, up to that read's deadline (ADR-0003). This applies to a cold key
  anywhere, and to an expired key outside `stale()`. There is no second read racing the first.
- With `stale()`, an expired panel or request list is up to one refresh behind. That is the price of answering at
  once. The request lists (Pending Approval, Decisions) refresh every 15 s, so a resolved request leaves within one
  more poll.
