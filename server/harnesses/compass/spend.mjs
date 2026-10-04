/**
 * Compass adapter — the spend read (U35, ES-4.13): GET /world/spend on the Worker (U35W), which prices every
 * ops_skill_runs row in a window against ops_config MODEL_PRICING and aggregates by client, skill, client×skill
 * and model. The world holds no token count, no price and no peg: this module fetches, whitelists the keys the
 * contract names (spec/world-spend.v1.json) and hands the object to the sidecar's GET /spend for the overlay to
 * fold through the pack's own room rule (overlay/spend.mjs). U36: estimates_version and the est objects on by_client
 * rows and totals ride through untouched — an estimate is read and shown on its own line, never summed here.
 *
 * Read only, cached 60 s per (window, include_test), and the last good answer survives a failed read (warned once
 * a minute) — the same discipline as the substrate read. With nothing ever read, `read()` returns EMPTY with the
 * error named, so a panel can say why its line is missing instead of printing zeros.
 *
 * U37 — today's cost per town: `today()` reads GET /ledger/cost?days=1 (Compass U5), the UTC day so far, priced by the
 * same code as /world/spend, grouped by town (ops_skill_runs.town, else the client — town_source says which). Same
 * cache, same last-good discipline; an answer without a by_town list is refused as malformed, not shown as zeros.
 *
 * Annex III: costs aggregate by client, town, skill and model only; the responses carry no per-person field and this
 * module names none (npm test greps it).
 */
import { withTimeout } from './health.mjs'

export const KEYS = Object.freeze(['at', 'window_days', 'pricing_version', 'pricing_verified', 'estimates_version', 'excluded_test_runs', 'display', 'totals', 'by_client', 'by_skill', 'by_client_skill', 'by_model'])
export const EMPTY = Object.freeze({ at: '', window_days: null, pricing_version: '', pricing_verified: '', estimates_version: '', excluded_test_runs: 0, display: null, totals: null, by_client: [], by_skill: [], by_client_skill: [], by_model: [], error: '' })

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const arr = (v) => (Array.isArray(v) ? v.filter(obj) : [])

/** Only the keys the contract names ride through; anything else the Worker might add stays on the Worker. */
export function normalise(body) {
  const b = obj(body) || {}
  return {
    at: typeof b.at === 'string' ? b.at : '',
    window_days: Number.isInteger(b.window_days) || b.window_days === 'all' ? b.window_days : null,
    pricing_version: typeof b.pricing_version === 'string' ? b.pricing_version : '',
    pricing_verified: typeof b.pricing_verified === 'string' ? b.pricing_verified : '',
    estimates_version: typeof b.estimates_version === 'string' ? b.estimates_version : '', // U36: absent → no estimates
    excluded_test_runs: Number.isInteger(b.excluded_test_runs) ? b.excluded_test_runs : 0,
    display: obj(b.display),
    totals: obj(b.totals),
    by_client: arr(b.by_client),
    by_skill: arr(b.by_skill),
    by_client_skill: arr(b.by_client_skill),
    by_model: arr(b.by_model),
    error: '',
  }
}

/** A window the Worker accepts: an integer 1–365 or 'all'; anything else falls back to the default. */
export function windowParam(v, fallback = 30) {
  if (v === 'all') return 'all'
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : fallback
}

export const TODAY_EMPTY = Object.freeze({ at: '', days: null, since: '', pricing_version: '', town_source: '', excluded_test_runs: 0, totals: null, by_town: [], error: '' })

/** U37: only the keys the day's answer needs; a by_town row must name its town. */
export function normaliseToday(body) {
  const b = obj(body) || {}
  return {
    at: typeof b.at === 'string' ? b.at : '',
    days: Number.isInteger(b.days) ? b.days : null,
    since: typeof b.since === 'string' ? b.since : '',
    pricing_version: typeof b.pricing_version === 'string' ? b.pricing_version : '',
    town_source: b.town_source === 'town' || b.town_source === 'client' ? b.town_source : '',
    excluded_test_runs: Number.isInteger(b.excluded_test_runs) ? b.excluded_test_runs : 0,
    totals: obj(b.totals),
    by_town: arr(b.by_town).filter((r) => typeof r.town === 'string' && r.town.trim()),
    error: '',
  }
}

export function createSpend(cfg, { fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.readTimeoutMs ?? 10_000) // U37: a deadline on every read
  const cache = new Map() // `${window}:${includeTest}` → { at, value }; U37: `today:${includeTest}` for the day's cost
  const warnedAt = new Map()

  /** One Worker read behind the cache: fresh for spendCacheMs, the last good answer kept on a failure, EMPTY + error with none. */
  async function cached(url, key, { what, empty, normaliseBody, valid = () => true, describe }) {
    const have = cache.get(key)
    if (have?.value && now() - have.at < cfg.spendCacheMs) return have.value
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${cfg.eventsBearerToken}`, Accept: 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`${what} read ${res.status}${body?.error ? `: ${body.error}` : ''}`)
      }
      const body = await res.json()
      if (!valid(body)) throw new Error(`${what} read: the answer is not the shape the contract names`)
      const value = normaliseBody(body)
      cache.set(key, { at: now(), value })
      log(describe(value))
      return value
    } catch (err) {
      if (now() - (warnedAt.get(what) ?? 0) > 60_000) {
        warnedAt.set(what, now())
        console.warn(`bot-crossing: compass — ${what} unavailable —`, err?.message || err)
      }
      if (!have?.value) return { ...empty, error: err?.message || String(err) }
      have.at = now() // keep the last good answer; try again after the cache period
      return have.value
    }
  }

  function read({ window, includeTest = false } = {}) {
    const w = windowParam(window, cfg.spendWindowDays || 30)
    const query = `${encodeURIComponent(String(w))}${includeTest ? '&include_test=1' : ''}`
    return cached(`${cfg.spendUrl}?window=${query}`, `${w}:${includeTest ? 1 : 0}`, {
      what: 'spend',
      empty: EMPTY,
      normaliseBody: normalise,
      describe: (value) => `spend ${w}d${includeTest ? ' +test' : ''}: ${value.totals?.runs_total ?? '?'} runs, ${value.totals?.runs_metered ?? '?'} metered, ${value.by_client.length} clients, ${value.by_skill.length} skills`,
    })
  }

  /** U37 — today's cost per town (GET /ledger/cost?days=1). */
  function today({ includeTest = false } = {}) {
    return cached(`${cfg.ledgerCostUrl}?days=1${includeTest ? '&include_test=1' : ''}`, `today:${includeTest ? 1 : 0}`, {
      what: "today's cost",
      empty: TODAY_EMPTY,
      normaliseBody: normaliseToday,
      valid: (body) => Boolean(obj(body)) && Array.isArray(body.by_town),
      describe: (value) => `today's cost${includeTest ? ' +test' : ''}: ${value.totals?.runs_total ?? '?'} runs, ${value.by_town.length} towns (by ${value.town_source || '?'})`,
    })
  }

  return { read, today, _cache: () => cache }
}
