# ADR-0006 — Identity for the hosted M3 world is Cloudflare Access with the firm's Google accounts

**Status:** Decided, to ratify · 2026-10-04 · by the developer under delegated authority (`docs/multiplayer.md`,
open question 1)

## Context
Today one viewer per process comes from `WORLD_VIEWER_PRESET`, with no login. `viewer.mjs` was built so M3 could swap
in an identity without a redesign. Two candidates were open: Cloudflare Access in front of the hosted world, or
Supabase Auth beside the ledger. Supabase Auth would live in the Lovable-managed project, which exposes no Supabase
URL or key outside Lovable.

## Decision
- The hosted world sits behind Cloudflare Access, signed in with the firm's Google accounts.
- The server maps the signed-in identity to a preset and a scope. The browser never says who it is.
- For now the grants come from configuration, not a table; a grant table in Compass is a later Decision.
- The side port asks `viewerFor(req)` on every request already. M3 changes what that function returns, not the
  rules it serves.
- Hosting itself is not in this batch.

## Consequences
- Identity decides what a viewer may see and tap. It never ranks, assigns or scores anyone (Annex III).
- The first M3 checks are in `docs/multiplayer.md`: signed out goes to the login page, a client grant gets one town
  and no spend, and a hosted plot drag is refused.
- Taps stay on the surfaces, under each person's own identity there (ADR-0001).
