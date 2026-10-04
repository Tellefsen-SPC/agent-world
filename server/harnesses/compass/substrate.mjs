/**
 * Compass adapter — the substrate read (U12): WORLD_COMPANIES, AUTO_RUN_POLICY, DEAL_PIPELINE_STAGES,
 * ops_clients (Active) and ops_skills, through the Worker's GET /world/substrate (U12W) over the
 * events bearer. No Supabase URL or key on this machine — the Worker owns that access.
 *
 * Read only, cached 60 s, and the last good answer survives a failed read (warned once a minute).
 * With nothing ever read, `read()` returns EMPTY and the world is a single home planet with no
 * towns — honest, and it costs nothing.
 *
 * v2 (Prompt B-2, live 2026-09-07): `version: 2` and, with it, `automations` (ops_automations — id, name, platform,
 * trigger_desc, updated_at; no status column, so none is read), `connectors` (ops_mcp_connectors — id, service, via,
 * updated_at; keyed by service, no status) and `rollups` { LAST_RUN_GOVERNANCE (null until the first Saturday 05:30
 * sweep), LAST_GATE_RECONCILIATION }. The branch is the `version` field, never key presence: a body without
 * `version: 2` is v1 whatever else it carries.
 */
import { withTimeout } from './health.mjs'

export const EMPTY = Object.freeze({ at: '', version: 1, world_companies: null, auto_run_policy: null, deal_pipeline_stages: [], clients: [], skills: [], automations: [], connectors: [], rollups: null })

const arr = (v) => (Array.isArray(v) ? v : [])
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)

export function normalise(body) {
  const b = obj(body) || {}
  const version = Number.isInteger(b.version) && b.version > 0 ? b.version : 1
  const v2 = version >= 2
  return {
    at: typeof b.at === 'string' ? b.at : '',
    version,
    world_companies: obj(b.world_companies),
    auto_run_policy: obj(b.auto_run_policy),
    deal_pipeline_stages: arr(b.deal_pipeline_stages).filter((s) => typeof s === 'string'),
    clients: arr(b.clients).filter(obj),
    skills: arr(b.skills).filter(obj),
    // v2 only — on v1 these stay empty even if a key happens to be present
    automations: v2 ? arr(b.automations).filter(obj) : [],
    connectors: v2 ? arr(b.connectors).filter(obj) : [],
    rollups: v2 ? obj(b.rollups) : null,
  }
}

export function createSubstrate(cfg, { fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.compassTimeoutMs ?? 10_000) // U37: a deadline on every read
  let cache = { at: 0, value: null }
  let warnedAt = 0

  async function read() {
    if (cache.value && now() - cache.at < cfg.substrateCacheMs) return cache.value
    try {
      const res = await fetchImpl(cfg.substrateUrl, {
        headers: { Authorization: `Bearer ${cfg.eventsBearerToken}`, Accept: 'application/json' },
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`substrate read ${res.status}${body?.error ? `: ${body.error}` : ''}`)
      }
      const value = normalise(await res.json())
      cache = { at: now(), value }
      log(`substrate v${value.version}: ${value.clients.length} clients, ${value.skills.length} skills, ${(value.world_companies?.companies || []).length} companies${value.version >= 2 ? `, ${value.automations.length} automations, ${value.connectors.length} connectors, rollups ${Object.keys(value.rollups || {}).join('/') || 'none'}` : ''}`)
    } catch (err) {
      if (now() - warnedAt > 60_000) {
        warnedAt = now()
        console.warn('bot-crossing: compass — substrate unavailable —', err?.message || err)
      }
      if (!cache.value) return EMPTY
      cache.at = now() // keep the last good answer; try again after the cache period
    }
    return cache.value
  }

  return { read, _cache: () => cache }
}
