# What multiplayer needs (M3)

Written 2026-10-04 for U37, the fork's half of the Engineering spine's U8 (*Agent World backend*: "write up
what multiplayer needs"). M3 is the hosted, multiplayer world with its first client town. This page says
what the world is today, what has to change before a second person opens it, and in what order. Nothing
here is built yet; hosting it is a deployment step and was out of scope for U37.

## What it is today: one person, one machine

| Part | Today | Where |
|---|---|---|
| Who is looking | One viewer per process, chosen by `WORLD_VIEWER_PRESET` (Owner by default). No login | `server/harnesses/compass/viewer.mjs` |
| Who can reach it | Loopback hosts only, plus the machine's own LAN addresses. A state change needs a local `Origin` | `server/api.mjs` (upstream, never edited), `compass/overlay-api.mjs` |
| What it reads | Four Worker routes, with one bearer token from `.env`, read on the server and cached there (scan 5 s; substrate, spend and today's cost 60 s) | `compass/config.mjs`, `docs/CONTRACT.md` |
| What it writes | Only the layout files `data/colony*.json`. The browser is the one writer: it PUTs the whole file | `server/api.mjs`, `overlay-api.mjs` |
| What hides spend | The overlay. `showSpend` hides the line unless the viewer is the Owner. The sidecar serves `/spend` and `/spend/today` to anyone who can reach it, which today means only the machine's owner | `overlay/spend.mjs` |
| When Compass is down | Every read has a deadline; the strip says "Compass unavailable" and shows the last thing the world saw (U37) | `compass/health.mjs` |

The viewer was built for this day. `viewer.mjs` passes a viewer everywhere "so M3 can swap in an identity
(Supabase Auth + RLS + `ops_world_grants`) without redesigning anything". There are five presets: owner,
operator, viewer, client and prime. A sixth is a decision.

## What has to change, in order

**1. Who is looking comes from a login, not the environment.**
- Put an identity-aware proxy in front of the hosted world, e.g. Cloudflare Access with the firm's Google
  accounts.
- The server maps the signed-in identity to a preset and a scope through a grant table (the
  `ops_world_grants` that `viewer.mjs` names). A grant looks like "this address is a client of town X".
- The browser never decides who it is. It is told.
- Annex III: identity decides what a viewer may **see** and **tap**. It is never used to rank, assign or
  score anyone, and the world still shows activity by place, never per person.

**2. The server enforces what a viewer may see. The overlay's checks become cosmetic.** This is the change
that matters most. Today the Owner-only rules (spend, content signatures, the surfaces each preset sees)
hold because the page applies them and only the owner can reach the server. Once others can reach it:
- `/spend` and `/spend/today` answer the Owner only;
- `/world`, `/rooms`, `/archive` and the thread list are cut to the viewer's scope before they leave the
  server. A client sees their own town, not the campus;
- this is a test before it is a feature. For every route, a non-Owner viewer gets nothing it should not
  have.

**3. One writer for the layout.**
- With many browsers PUTting the whole `colony.json`, the last write wins and moves wipe each other out.
- Recommended: only the Owner (the `layout` capability) can write. Everyone else reads the layout the
  Owner made.
- The layout generator (U29) is deterministic, so a fresh world needs no writer at all.

**4. Hosting that keeps `api.mjs` untouched.**
- The world is a Node server (`server/serve.mjs` serving the built page, the upstream API, and the
  adapter's sidecar), not a static site. Cloudflare Pages alone can only host the built page (conflict
  C10).
- `api.mjs` is on the never-touch list, and it refuses any `Host` that is not local. Two ways to host it:
  - **Recommended:** a small container or VM runs `npm start`, reached only through a tunnel (e.g.
    `cloudflared`) that presents a local `Host` and sits behind Access. Nothing in the fork changes.
  - The alternative is porting the API to a Worker, which means rewriting upstream code the fork promised
    to leave alone.
- The bearer token stays on the server, as it does today. It is never a `VITE_` variable and never in the
  bundle.

**5. One read for everyone.**
- The adapter already reads Compass once per cache period, however many pages poll it. N viewers is not
  N times the load on Compass.
- What grows is each browser polling `/api/threads`. That is fine for a handful of people. Past that, push
  changes (server-sent events) instead of polling.
- Every viewer sees the same "Compass unavailable" pill, because Compass's state is server state.

**6. The tap stays where it is.** The world deep-links to the surface where an approval happens (Compass,
Notion, Airtable), and the person approves there under their own identity. Multiplayer does not give the
world a write path, and Compass's MCP having no caller identity (fragility N12) stays Compass's problem,
not the world's.

## Checks for M3, before anyone else opens it

- Signed out → the proxy's login page; the world's own ports are not reachable from outside.
- A client grant → only that client's town, no campus rooms, no spend line, no `/spend` answer.
- An operator → the campus, with taps on `pending_approval` and `class_b_gate` only.
- Two Owners moving plots at once → one layout wins and the other sees it on reload; nothing corrupts.
- A dead Compass URL → the pill on every viewer's strip, no crash (V-U37 already covers one viewer).
- `git diff upstream/main -- src/ server/api.mjs server/scan.mjs server/harnesses/claude-code.mjs` → empty.

## Open questions for Christoffer

1. **Identity provider.** Cloudflare Access with the firm's Google accounts is the shortest path. Supabase
   Auth (what `viewer.mjs` anticipated) puts the grants next to the ledger. One is enough; pick one.
2. **Where the grant table lives.** Compass (`ops_world_grants`, a migration through the U3 runner) or a
   config key. A table is easier to audit.
3. **Does a client ever see cost?** Today spend is Owner-only by design. Showing a client their own town's
   cost is a commercial decision, not a technical one.
