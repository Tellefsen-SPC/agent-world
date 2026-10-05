# ADR-0001 — The world renders the substrate and never writes to it

**Status:** Accepted · 2026-09-06 · Build Pack, written by build-kickoff v1.3 and approved by Christoffer in-session
(ledger run `d29548c0`) · SPEC.md §1, CLAUDE.md "System of record"

## Context
The Run Ledger (`ops_run_events`, `ops_skill_runs` in Compass), the Notion Milestones and Decisions and the Airtable
Pending Approval rows are the firm's record. Skills, Cowork jobs, the Worker and the hooks write them. A viewer that
also wrote would be a second writer nobody governs.

## Decision
Agent World is a mirror. It reads Compass through the Worker's GET routes and Notion and Airtable with GETs. The one
Notion data-source query is a read with a body, guarded by an allow-list. It writes nothing back: no rows, no
`gate_passed`, no archive flags. A tap happens on the surface itself; the world deep-links to it. The world's only
write is its own layout, `data/colony*.json`. A design that needs the world to store or write something stops and
becomes a Decision.

## Consequences
- `npm test` fails on a non-GET request or a write chain anywhere in the adapter (`test/invariants.test.mjs`), and on
  a Worker route outside the contract (`test/contract.test.mjs`).
- A `?` can lag the tap by one poll, and that is accepted (U6 reads the surface to close the gap). The fix is never
  a write.
- The test-data script deletes `zztest-*` runs through the Worker. It is a fixture, not the world.
