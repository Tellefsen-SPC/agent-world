/**
 * Compass adapter — configuration from the environment.
 *
 * No Supabase URL or service-role key here: the Compass Supabase project is provisioned through
 * Lovable Cloud, which does not expose either outside the Worker that already owns them. Reads go
 * through the Worker's /ledger/scan route (worker/ledger-read.mjs) over the same bearer token
 * /events already uses — so `ledgerUrl` is derived from `EVENTS_URL`, not configured separately.
 */
const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

/** U16: the side port's wait for the PA — the default, and the most any setting may give it (below the page's 60 s). */
export const ASK_TIMEOUT_MS = 50_000
export const MAX_ASK_TIMEOUT_MS = 55_000
const portOf = (v, d) => {
  const n = Number(String(v ?? '').trim())
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : d
}

/**
 * The Compass approvals console's proposal pages (Worker branch compass-console): <worker base>/console/proposals, where
 * <worker base> is EVENTS_URL with its /events tail removed, as for every route here. A page a human opens in the
 * browser, never a read: the adapter links to it (threads.mjs approvalConsoleUrl) and never fetches it. Only an https
 * EVENTS_URL ending in /events, with no user, password, query or fragment, gives one; anything else gives '' and an
 * approval gate then gets no link.
 */
function consoleProposalsUrlOf(eventsUrl) {
  let u
  try {
    u = new URL(eventsUrl)
  } catch {
    return ''
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !/\/events$/.test(u.pathname)) return ''
  return `${u.origin}${u.pathname.replace(/\/events$/, '')}/console/proposals`
}

export function loadConfig(env = process.env) {
  const eventsUrl = (env.EVENTS_URL || '').replace(/\/+$/, '')
  return {
    eventsUrl,
    eventsBearerToken: env.EVENTS_BEARER_TOKEN || '',
    /** Sibling of EVENTS_URL: .../events → .../ledger/scan. No separate env var needed. */
    ledgerUrl: eventsUrl.replace(/\/events$/, '/ledger/scan'),
    /** Sibling of EVENTS_URL: .../events → .../world/substrate (U12W). Same bearer; 60 s cache. */
    substrateUrl: eventsUrl.replace(/\/events$/, '/world/substrate'),
    substrateCacheMs: 60_000,
    /** Sibling of EVENTS_URL: .../events → .../world/spend (U35W, ES-4.13). Same bearer; 60 s cache per window. */
    spendUrl: eventsUrl.replace(/\/events$/, '/world/spend'),
    /** U37: today's cost per town — GET /ledger/cost (Compass U5). Same bearer, same 60 s cache. */
    ledgerCostUrl: eventsUrl.replace(/\/events$/, '/ledger/cost'),
    /**
     * U7: the realtime nudge — GET /events/stream on the Worker (approval layer P8): the ledger as server-sent events,
     * same bearer. An event drops the scan cache so the next poll reads the ledger again (compass/stream.mjs). Derived
     * only from an EVENTS_URL that ends in /events; WORLD_STREAM=0 (or off/false/no) switches it off.
     */
    streamUrl: /\/events$/.test(eventsUrl) ? eventsUrl.replace(/\/events$/, '/events/stream') : '',
    streamEnabled: !/^(0|off|false|no)$/i.test(String(env.WORLD_STREAM ?? '').trim()),
    /**
     * U16W: the PA — POST /ask on the Worker (ES-4.6), the one Worker route the adapter asks rather than reads. Only the
     * sidecar's POST /ask uses it (compass/ask.mjs): the browser never holds the bearer (docs/adr/0008). Derived only
     * from an EVENTS_URL that ends in /events, like the stream. The Worker takes ASK_BEARER when it has one, else the
     * events bearer; WORLD_ASK_BEARER is this machine's copy of the first, and the events bearer stands in without it.
     * The deadline: 50 s by default — above the Worker's own 28 s budget after an ask starts, so its 502s arrive first —
     * and at most 55 s, so it always ends before the page's own 60 s wait (overlay/zones.mjs ASK_PAGE_TIMEOUT_MS) and the
     * page hears the side port's 504 rather than giving up blind. A value that is not a positive number is the default.
     */
    askUrl: /\/events$/.test(eventsUrl) ? eventsUrl.replace(/\/events$/, '/ask') : '',
    askBearerToken: String(env.WORLD_ASK_BEARER || '').trim() || env.EVENTS_BEARER_TOKEN || '',
    askTimeoutMs: Math.min(num(env.WORLD_ASK_TIMEOUT_MS, ASK_TIMEOUT_MS), MAX_ASK_TIMEOUT_MS),
    /** Where an approval-layer gate opens (surface "approval"): the console's proposal pages, https only — a link, never a read. */
    consoleProposalsUrl: consoleProposalsUrlOf(eventsUrl),
    /**
     * The world's own page port (Vite and `npm start` listen on PORT, default 5274). The side port answers the PA only
     * for a page from this port on a loopback host — any other local page is refused (review nit 6, 2026-10-05).
     */
    pagePort: portOf(env.PORT, 5274),
    spendCacheMs: 60_000,
    spendWindowDays: 30,
    /** The overlay sidecar's loopback port (overlay-api.mjs); 0 disables it (home planet only). */
    overlayPort: env.WORLD_OVERLAY_PORT === undefined ? 5275 : Math.max(0, Number(env.WORLD_OVERLAY_PORT) || 0),
    notionToken: env.NOTION_TOKEN || '',
    airtableToken: env.AIRTABLE_TOKEN || '',
    airtableBaseId: env.AIRTABLE_BASE_ID || 'appixWl8C3bogLsvp',
    claudeProjectUrl: env.CLAUDE_PROJECT_URL || '',
    tenant: env.WORLD_TENANT || 'tellefsen',
    viewerPreset: env.WORLD_VIEWER_PRESET || 'owner',
    windowDays: num(env.WORLD_WINDOW_DAYS, 14),
    runningTtlMs: num(env.WORLD_RUNNING_TTL_HOURS, 2) * 3600 * 1000,
    scanCacheMs: 5000,
    /**
     * U37: how long a read may take. The ledger scan runs 6–9 s on a normal day (measured 2026-09-07); the 30-day
     * background scan (U17 hand-raise) reads about twice the window, off the poll's path, so it waits longer;
     * every other read — Compass substrate and spend, Notion, Airtable — is small.
     */
    ledgerTimeoutMs: num(env.WORLD_LEDGER_TIMEOUT_MS, 25_000),
    ledgerLongTimeoutMs: num(env.WORLD_LEDGER_LONG_TIMEOUT_MS, 120_000),
    readTimeoutMs: num(env.WORLD_READ_TIMEOUT_MS, 10_000),
    debug: /\bworld\b|\*/.test(env.DEBUG || ''),
  }
}

/**
 * Zone name for runs with no client — the campus centre, and the plot key every saved layout
 * already carries. The only name in the adapter; the overlay and the packs carry none (npm test).
 */
export const CAMPUS = 'Tellefsen HQ'
