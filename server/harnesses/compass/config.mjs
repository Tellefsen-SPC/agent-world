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
    /** U37: how long a Compass read may take. The ledger scan runs 6–9 s on a normal day (measured 2026-09-07). */
    ledgerTimeoutMs: num(env.WORLD_LEDGER_TIMEOUT_MS, 25_000),
    compassTimeoutMs: num(env.WORLD_COMPASS_TIMEOUT_MS, 10_000),
    debug: /\bworld\b|\*/.test(env.DEBUG || ''),
  }
}

/**
 * Zone name for runs with no client — the campus centre, and the plot key every saved layout
 * already carries. The only name in the adapter; the overlay and the packs carry none (npm test).
 */
export const CAMPUS = 'Tellefsen HQ'
