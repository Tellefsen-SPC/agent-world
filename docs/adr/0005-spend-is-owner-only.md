# ADR-0005 — Spend is the Owner's: clients never see cost, and the server enforces it

**Status:** Decided by the developer under delegated authority, 2026-10-04 — to ratify as a 🧠 Decision (D10 in `~/Projects/tellefsen/deliverables/decisions-2026-10-04.md`). Not firm policy until Christoffer logs it; until then the code keeps the safe default below.
The rule it builds on — spend is shown to the Owner preset only, never per person — is Christoffer's own call
(ES-4.13 / Component 9, 2026-09-08).

## Context
Town cards and room panels carry tokens and list-price cost (U35), chat-usage estimates (U36) and today's cost (U37).
Until 2026-10-04 only the overlay hid them (`showSpend`). The side port served `/spend` and `/spend/today` to anyone
who could reach it, which was safe only while that was the Owner's own machine. M3 opens the world to others.
`docs/multiplayer.md` left open whether a client may see their own town's cost.

## Decision
- Cost is shown to the Owner preset only (ES-4.13), and never to a client, not even for their own town (D10, to
  ratify; showing a client their own cost is a commercial question nobody has asked yet).
- It is never per person (Annex III): spend aggregates by client, town, skill and model only.
- The server decides. The side port answers `/spend` and `/spend/today` with 403 `{error}` unless the viewer is
  Owner, before it reads the Worker. The overlay's check is the second line.
- A viewer the server cannot resolve is refused (it fails closed).

## Consequences
- A client grant at M3 needs no special case for spend: it is already refused.
- **Open risk:** the repository is public, and `test/fixtures/m2b-spend.live.json` publishes per-client cost and
  estimate figures. Making the repo private (an owner action) closes it for the future; what is already public
  stays in its history.
