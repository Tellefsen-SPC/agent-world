# What multiplayer needs (M3)

Written 2026-10-04 for U37, the fork's half of the Engineering spine's U8 (*Agent World backend*: "write up
what multiplayer needs"). M3 is the hosted, multiplayer world with its first client town. This page says
what the world is today, what has to change before a second person opens it, and in what order. Nothing
here is built yet; hosting it is a deployment step and was out of scope for U37. File references are to
this repo as of U37.

## What it is today: one person, one machine

| Part | Today | Where |
|---|---|---|
| Who is looking | One viewer per process, chosen by `WORLD_VIEWER_PRESET` (Owner by default). No login | `server/harnesses/compass/viewer.mjs` |
| Who can reach it | The upstream API wants a local `Host` (loopback, or the machine's own LAN address) on every request, and a local `Origin` whenever one is sent. The sidecar is stricter on `Host` (loopback only). It answers a GET that carries a foreign `Origin`, but without CORS headers, so a page from elsewhere cannot read the answer | `server/api.mjs` `isLocalRequest` (upstream, never edited), `compass/overlay-api.mjs` |
| How the page finds the sidecar | `location.hostname` on port 5275: a second origin beside the page | `overlay/zones.mjs` `SIDECAR` |
| What it reads | Four Worker routes with one bearer token, plus Notion and Airtable with their own tokens (`NOTION_TOKEN`, `AIRTABLE_TOKEN`). Since U7 (2026-10-04) the adapter also listens to a fifth, the Worker's `GET /events/stream`, and drops its scan cache on each event. All of it is read on the server, never in the browser | `compass/config.mjs`, `compass/stream.mjs`, `docs/CONTRACT.md` |
| How often | Cached on the server: substrate, spend and today's cost 60 s; room panels 5 min. The ledger scan's 5 s cache counts from the start of the scan. A live scan takes 6–9 s, so with pages polling, scans run back to back, one at a time: polls that land during a scan share it. Since 2026-10-04 every other cache does the same: one read in flight per cache key (substrate, spend, today's cost, the 5-minute panels, milestone progress), so viewers polling as a cache expires share one read | `compass.mjs` `scanThreads`, `substrate.mjs`, `spend.mjs`, `surfaces.mjs` `stale()`, `steering.mjs`, `rooms.mjs` |
| What it writes | Only the layout files `data/colony*.json`, written three ways: the browser PUTs them whole (`/api/state`, the sidecar's `/planets/<key>/state`); the server writes one when its first layout pass in a process places a new town; and the sidecar creates an empty planet file on that planet's first GET. The sidecar's PUT needs a viewer with the `layout` capability (Owner); anyone else gets 403 (2026-10-04) | `server/api.mjs`, `overlay-api.mjs`, `compass.mjs` `ensureLayouts` |
| What hides spend | The server first: the sidecar answers `/spend` and `/spend/today` with 403 `{error}` unless the viewer preset is Owner, before it reads the Worker (2026-10-04). The overlay's `showSpend` is the second line | `compass/overlay-api.mjs`, `overlay/spend.mjs` |
| When Compass is down | Every read has a deadline that covers the whole answer, body included. The strip says "Compass unavailable" when the ledger scan or the substrate is failing, and shows the last thing the world saw (U37) | `compass/health.mjs` |

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

**2. The server enforces what a viewer may see, so the overlay's checks are no longer the only line.** This
is the change that matters most.

Today the Owner-only rules (spend, content signatures, the surfaces each preset sees) hold because the page
applies them and only the owner can reach the server. Once others can reach it, every route is cut to the
viewer's scope before it leaves the server:
- **The sidecar (fork code):** `/world`, `/steering`, `/rooms`, `/rooms/<id>`, `/archive`, `/spend`,
  `/spend/today` and `/planets/<key>/state`. A client sees their own town, not the campus.
  - **Done (2026-10-04):** `/spend` and `/spend/today` answer the Owner only, and a PUT to
    `/planets/<key>/state` needs the `layout` capability. Both ask `viewerFor(req)`, so M3 changes who the viewer
    is, not the rule. With no viewer the answer is no (`test/sidecar-gates.test.mjs`).
  - Still to do: cut `/world`, `/steering`, `/rooms` and `/archive` to the viewer's scope.
- **The upstream API (never edited):**
  - It has no idea of a viewer. Per-viewer thread lists need a fork-owned layer in front of it that filters by the
    signed-in scope, or a change upstream.
  - Reads: `/api/threads`, `/api/harnesses`, `/api/state`.
  - Writes: PUT `/api/state`, and POST `/api/open`, `/api/reveal` and `/api/archive`. A hosted `Origin` is already
    refused on all of them (see 3).

Tests come before the feature: for every route, a non-Owner viewer gets nothing it should not have.

**3. One writer for the layout.** Hosting settles this, because `api.mjs` refuses a state PUT whose `Origin` is
not local, and it is never edited:
- A browser on the hosted address cannot write `/api/state`.
- **Recommended:** the hosted world is read-only for layout. The Owner arranges plots on their own machine,
  as today, and that layout is what the hosted world serves.
- The server's own first layout (`ensureLayouts`, the U29 generator) still works: it is deterministic and
  needs no browser.
- The sidecar's `/planets/<key>/state` PUT (fork code) follows the same rule: it needs a local `Origin` and,
  since 2026-10-04, a viewer with the `layout` capability (Owner).

**4. Hosting is mostly fork changes, and `api.mjs` stays untouched.** The world is a Node server
(`server/serve.mjs`: the built page, the upstream API, and the adapter's sidecar), not a static site.
Cloudflare Pages alone can only host the built page (conflict C10). What has to change:
- **One origin for everything.** The page reaches the sidecar on `location.hostname:5275`, a second origin,
  and the sidecar accepts only a local `Host` and a local `Origin`. A hosted world needs:
  - a reverse proxy that serves the page, `/api/*` and the sidecar under one hosted name;
  - `zones.mjs` pointing `SIDECAR` at a path on that origin instead of a port;
  - `overlay-api.mjs` accepting the hosted name, but only behind the proxy.
  All of these are fork files.
- **The upstream API behind the proxy.** It needs a local `Host`, which the proxy can present, e.g. a
  `cloudflared` tunnel with its origin host header set to `localhost`. Same-origin GETs from the browser
  carry no `Origin` and pass. PUTs do not (see 3).
- **One small machine** (a container or VM) runs `npm start` behind the proxy and Access.
- **The tokens stay on the server**, as they do today. The Worker bearer, Notion and Airtable tokens are
  never `VITE_` variables and never in the bundle.
- The alternative, porting the API to a Worker, rewrites upstream code the fork promised to leave alone.

**5. Reads that hold up with many viewers.**
- The ledger scan is already shared across polls.
- **Done (2026-10-04):** the substrate, spend, today's cost, the room panels, the steering panels and milestone
  progress have the same single in-flight read, so a cache expiring under ten viewers is one read of Compass,
  Notion or Airtable, not ten (`test/single-flight.test.mjs` counts the fetches).
- Past a handful of people, push changes (server-sent events) instead of each browser polling
  `/api/threads` every 15 s. The server half exists since U7: the adapter already holds one stream from the
  Worker. Passing it on to browsers needs an endpoint on the sidecar and an overlay change; the page's own poll is
  upstream `src/` and stays.
- Every viewer sees the same "Compass unavailable" pill, because Compass's state is server state.

**6. The tap stays where it is.** The world deep-links to the surface where an approval happens (Compass,
Notion, Airtable), and the person approves there under their own identity. Multiplayer does not give the
world a write path to the substrate, and Compass's MCP having no caller identity (fragility N12) stays
Compass's problem, not the world's.

## Checks for M3, before anyone else opens it

- Signed out → the proxy's login page. The world's own ports are not reachable from outside.
- A client grant → only that client's town: no campus rooms, no spend line, and nothing from `/spend`,
  `/spend/today`, `/steering`, `/rooms` or other towns' `/planets/<key>/state`.
- An operator → the campus, with taps on `pending_approval` and `class_b_gate` only.
- A plot dragged on the hosted world → refused, and the layout is unchanged. On the Owner's own machine it
  still moves.
- A dead or hanging Compass → the pill on every viewer's strip, no crash (V-U37 covers one viewer).
- `git diff $(git merge-base HEAD upstream/main) -- src/ server/api.mjs server/scan.mjs server/harnesses/claude-code.mjs`
  → empty.

## Open questions for Christoffer

1. **Identity provider.** *Decided 2026-10-04 by the developer under delegated authority, to ratify:*
   Cloudflare Access with the firm's Google accounts, grants from configuration for now (`docs/adr/0006`).
   Supabase Auth (what `viewer.mjs` anticipated) would have put the grants next to the ledger.
2. **Where the grant table lives.** Compass (`ops_world_grants`, a migration through the U3 runner) or a
   config key. A table is easier to audit.
3. **Does a client ever see cost?** *Decided 2026-10-04 by the developer under delegated authority, to
   ratify:* no. Spend stays Owner-only, and the side port enforces it (`docs/adr/0005`). Note that the repo is
   public today and its spend fixture publishes per-client figures; making it private is an owner action.
