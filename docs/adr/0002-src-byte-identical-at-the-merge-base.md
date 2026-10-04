# ADR-0002 — `src/` and the never-touch files stay byte-identical to upstream, checked against the merge-base

**Status:** Accepted · 2026-09-06 · U1, SPEC.md ES-1.1 (the rule) · Decided, to ratify · 2026-10-04 · U37 (checked
against the merge-base)

## Context
The fork is Bot Crossing (jarrenrocks/bot-crossing, MIT) with one adapter. Staying mergeable with upstream is what
makes the fork cheap. The first check diffed against `upstream/main`'s tip, and it failed for everyone the day
upstream committed anything (upstream had moved 55 commits by 2026-10-04).

## Decision
`src/`, `server/scan.mjs`, `server/api.mjs` and `server/harnesses/claude-code.mjs` are never edited here. A change
they need is an upstream PR, then a merge. `npm test` diffs them against `git merge-base HEAD upstream/main`, the
upstream commit the fork is built on (87ec837 today). CI adds and fetches `upstream` to compute it.

## Consequences
- Fork code lives in `server/harnesses/compass*`, `overlay/` (mounted from `index.html`) and the side port. Anything
  the renderer cannot do through that seam is reported, not patched.
- Merging upstream moves the merge-base forward on purpose; upstream merely moving on does not fail the test.
- `server/api.mjs` keeps its own rules, for example refusing a non-local `Origin`. The fork works around them and
  never edits them (`docs/multiplayer.md`).
