# Architecture decision records — Agent World

One short record per standing call in this fork, so a later reader does not have to reverse-engineer it from the
code. A firm-level change (scope, what the world may show, who may see it) is a 🧠 Decision on the Notion project
page first; the record here points to it.

Status:
- **Accepted:** Christoffer's call. The record says where he made it.
- **Decided, to ratify:** taken by the developer under delegated authority. It is in force, and goes to
  Christoffer at the next build-kickoff refresh.
- **Proposed:** an engineering call the builder made, awaiting review. The builder does not accept their own
  calls.

| # | Decision | Since | Status |
|---|---|---|---|
| [0001](0001-render-only.md) | The world renders the substrate and never writes to it | 2026-09-06 · Build Pack | Accepted |
| [0002](0002-src-byte-identical-at-the-merge-base.md) | `src/` and the never-touch files stay byte-identical to upstream, checked against the merge-base | 2026-09-06 · U1; merge-base 2026-10-04 · U37 | Accepted (the rule) · Decided, to ratify (the merge-base check) |
| [0003](0003-every-read-has-a-deadline.md) | Every read has a deadline, and the deadline covers the body | 2026-10-04 · U37 | Decided, to ratify |
| [0004](0004-one-read-at-a-time.md) | One scan at a time, health per source, one read in flight per cache key | 2026-10-04 · U37 and the ops batch | Decided, to ratify |
| [0005](0005-spend-is-owner-only.md) | Spend is the Owner's: clients never see cost, and the server enforces it | 2026-09-08 · ES-4.13; 2026-10-04 | Accepted (Owner-only) · Decided, to ratify (clients never; server-side) |
| [0006](0006-m3-identity-is-cloudflare-access.md) | Identity for the hosted M3 world is Cloudflare Access with the firm's Google accounts | 2026-10-04 | Decided, to ratify |
| [0007](0007-realtime-nudge-over-the-worker-stream.md) | The realtime nudge listens to the Worker's event stream, never Supabase | 2026-10-04 · U7 | Decided, to ratify |

Format: Status · Context · Decision · Consequences, a page at most. A superseded record stays, marked
`Superseded by NNNN`.
