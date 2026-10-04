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
