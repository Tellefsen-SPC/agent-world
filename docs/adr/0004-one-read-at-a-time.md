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
  A caller on a cold or expired key gets that read's answer, never a fallback.

## Consequences
- A cache expiring under many viewers is one read of Compass, Notion or Airtable (`test/single-flight.test.mjs`
  counts them).
- A slow read slows every caller waiting on it, up to that read's deadline (ADR-0003). There is no second read racing
  the first.
