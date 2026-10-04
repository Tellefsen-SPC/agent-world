/**
 * Steering Room reads (U19) — three panels from the substrate, each a 5-minute cache, none a write.
 *
 *   pipeline    Airtable HQ Pipeline (tbl5OkxwL3WqTK6Vz): every row with its Stage (the enum is
 *               DEAL_PIPELINE_STAGES from /world/substrate — never hardcoded here), the deal's name and
 *               days since last touch. The hot deals are the rows whose Stage is open (not Won / Lost /
 *               Parked), ordered by the enum, then the longest-untouched first. U20 reads the same rows.
 *   milestones  the next milestone per Active project — the Projects data source filtered on Status,
 *               then U4's own milestone read (surfaces.milestones) per project.
 *   decisions   the last three 🧠 Decisions with Status Active or Pending, newest first.
 *
 * Notion has no GET that lists a database's rows: listing is POST /v1/data_sources/<id>/query, a read
 * with a body (filter, sort, page size). Since M2b (B5) that one request lives in compass/notion.mjs and is
 * allowed only for the ids in compass/notion-sources.mjs; this file calls it and builds no request of its own.
 *
 * Last touch of a deal, first field that is set wins: `Last Touch` (a date the skills write, when the base
 * has one — proposed), else `Last Viewed` (the prospect opening the interactive page), else `Stage Changed
 * Date` (Airtable's own stamp on the Stage field — it moves on any write to Stage, even to the same value),
 * else `Created Date`. A chain, not a max: the stamp would otherwise hide every human-set date. The seed sets
 * the ZZTEST row's Last Viewed twelve days back so the panels read "12 d" (V-U19/V-U20).
 */
import { createNotion } from './notion.mjs'
import { PROJECTS as PROJECTS_DATA_SOURCE, DECISIONS as DECISIONS_DATA_SOURCE } from './notion-sources.mjs'
import { withTimeout } from './health.mjs'
export const PIPELINE_TABLE = 'tbl5OkxwL3WqTK6Vz'
export { PROJECTS_DATA_SOURCE, DECISIONS_DATA_SOURCE }
export const CACHE_MS = 5 * 60_000
export const ERROR_MS = 30_000
/** Prospect plots (U20) follow a Stage change "on the next poll": their own read of the same table, cached for the poll's own 15 s. */
export const PROSPECTS_MS = 15_000
export const CLOSED_STAGES = /^(won|lost|parked)$/i
/** The Airtable view that IS the hot-deals list (V-U19 compares against it): its rows, its order. Overridable by env. */
export const HOT_VIEW = process.env.PIPELINE_HOT_VIEW || 'Active pipeline'
const DAY_MS = 24 * 3600 * 1000

const str = (v) => (typeof v === 'string' ? v.trim() : '')
const plain = (rich) => (Array.isArray(rich) ? rich.map((t) => t?.plain_text || '').join('') : '')
const selectName = (prop) => {
  const t = prop?.type
  return t === 'select' || t === 'status' ? prop[t]?.name || '' : ''
}
const ms = (iso) => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** Pure: an Airtable Pipeline record → a row. `stages` orders it; an unknown stage sorts last. */
export function pipelineRow(record, stages = [], now = Date.now()) {
  const f = record?.fields || {}
  const touchAt = ms(f['Last Touch']) || ms(f['Last Viewed']) || ms(f['Stage Changed Date']) || ms(f['Created Date'])
  const stage = str(f.Stage)
  const idx = stages.indexOf(stage)
  return {
    id: str(record?.id),
    name: str(f['Opportunity Name']) || '(unnamed)',
    stage,
    stageIndex: idx < 0 ? stages.length : idx,
    open: Boolean(stage) && !CLOSED_STAGES.test(stage),
    won: /^won$/i.test(stage),
    lost: /^lost$/i.test(stage),
    touchAt,
    days: touchAt ? Math.max(0, Math.floor((now - touchAt) / DAY_MS)) : null,
    clientIds: Array.isArray(f.Client) ? f.Client.map(str).filter(Boolean) : [],
    nextAction: str(f['Next Action']),
    url: record?.id ? `https://airtable.com/${record.baseId || ''}/${PIPELINE_TABLE}/${record.id}` : '',
  }
}

/** Pure: the hot deals — open rows, by the enum, longest-untouched first within a stage. */
export const hotDeals = (rows) => rows.filter((r) => r.open).sort((a, b) => a.stageIndex - b.stageIndex || (b.days ?? -1) - (a.days ?? -1) || a.name.localeCompare(b.name))

/** Pure: the next milestone of a project — the first not-done one by committed date, then sequence. */
export function nextMilestone(list) {
  const open = (list || []).filter((m) => !m.done)
  open.sort((a, b) => (a.committed || Infinity) - (b.committed || Infinity) || (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.name.localeCompare(b.name))
  return open[0] || null
}

export function createSteering(cfg, { surfaces, substrate, fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.readTimeoutMs ?? 10_000) // U37: a deadline on every read
  const caches = new Map() // key → { at, value }
  /** A good answer lives CACHE_MS; an answer that names an error is retried after ERROR_MS, so a blip does not blank a panel for five minutes. */
  const cached = async (key, fn) => {
    const hit = caches.get(key)
    if (hit && now() - hit.at < (hit.value?.error ? ERROR_MS : CACHE_MS)) return hit.value
    const value = await fn()
    caches.set(key, { at: now(), value })
    return value
  }
  const fix = (status, what) =>
    status === 404 ? `${what}: not shared with the integration — share it with the "Tellefsen - Agent world" integration` : status === 401 ? `${what}: the token was refused — check NOTION_TOKEN in .env` : `${what}: read failed (${status})`
  const fixAirtable = (status) =>
    status === 404 ? `Airtable Pipeline: base or table not found — check AIRTABLE_BASE_ID (${cfg.airtableBaseId}) and that the token can see the HQ base` : status === 401 || status === 403 ? 'Airtable Pipeline: the token was refused — check AIRTABLE_TOKEN in .env and its data.records:read scope' : `Airtable Pipeline: read failed (${status})`

  const notionClient = createNotion(cfg, { fetchImpl })
  /** A data-source query through the shared client (compass/notion.mjs) — one page, as before. */
  const notion = (path, body) => {
    const m = String(path).match(/^data_sources\/([^/]+)\/query$/)
    if (!m || !body) throw Object.assign(new Error(`steering reads only data-source queries, not ${path}`), { status: 0 })
    return notionClient.queryPage(m[1], body)
  }

  // ── panel 1: Pipeline ──────────────────────────────────────────────────────────────────────
  async function pipeline() {
    return cached('pipeline', async () => {
      const stages = (await substrate.read()).deal_pipeline_stages || []
      if (!cfg.airtableToken) return { rows: [], hot: [], view: '', stages, error: 'AIRTABLE_TOKEN is not set in .env' }
      try {
        const list = async (query) => {
          const records = []
          let offset = ''
          do {
            const url = `https://api.airtable.com/v0/${cfg.airtableBaseId}/${PIPELINE_TABLE}?pageSize=100${query}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`
            const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.airtableToken}` } })
            const json = (res.ok ? await res.json() : await res.json().catch(() => ({})))
            if (!res.ok) throw Object.assign(new Error(fixAirtable(res.status)), { status: res.status, named: true })
            for (const r of json.records || []) records.push({ ...r, baseId: cfg.airtableBaseId })
            offset = json.offset || ''
          } while (offset)
          return records
        }
        const t = now()
        const rows = (await list('')).map((r) => pipelineRow(r, stages, t))
        // the hot deals: the view's rows in the view's order; without the view, the enum order over the open rows
        let hot = null
        let view = ''
        try {
          hot = (await list(`&view=${encodeURIComponent(HOT_VIEW)}`)).map((r) => pipelineRow(r, stages, t))
          view = HOT_VIEW
        } catch (err) {
          log(`steering: view "${HOT_VIEW}" not readable (${err.message}) — ordering the open rows by the enum`)
        }
        if (!hot) hot = hotDeals(rows)
        log(`steering: pipeline ${rows.length} rows, ${hot.length} hot`)
        return { rows, hot, view, stages, error: '' }
      } catch (err) {
        return { rows: [], hot: [], view: '', stages, error: err.named ? err.message : `Airtable Pipeline: ${err.message}` }
      }
    })
  }

  // ── panel 2: the milestone board ───────────────────────────────────────────────────────────
  async function milestoneBoard() {
    return cached('milestones', async () => {
      try {
        const q = await notion(`data_sources/${PROJECTS_DATA_SOURCE}/query`, { filter: { property: 'Status', select: { equals: 'Active' } }, page_size: 100 })
        const rows = []
        for (const p of q.results || []) {
          const { list = [], value } = await surfaces.milestones(p.id)
          const next = nextMilestone(list)
          rows.push({
            project: plain(p.properties?.Name?.title) || p.id,
            projectId: p.id,
            url: p.url || '',
            progress: value,
            total: list.length,
            done: list.filter((m) => m.done).length,
            next: next ? { name: next.name, status: next.status, committed: next.committed || 0, url: next.url || '' } : null,
          })
        }
        rows.sort((a, b) => (a.next?.committed || Infinity) - (b.next?.committed || Infinity) || a.project.localeCompare(b.project))
        log(`steering: milestone board ${rows.length} projects`)
        return { rows, error: '' }
      } catch (err) {
        return { rows: [], error: fix(err.status, 'Projects (Notion)') + (err.status ? '' : ` — ${err.message}`) }
      }
    })
  }

  // ── panel 3: the last three Decisions ──────────────────────────────────────────────────────
  async function decisions() {
    return cached('decisions', async () => {
      try {
        const q = await notion(`data_sources/${DECISIONS_DATA_SOURCE}/query`, {
          filter: { or: [{ property: 'Status', select: { equals: 'Active' } }, { property: 'Status', select: { equals: 'Pending' } }] },
          sorts: [{ property: 'Date', direction: 'descending' }, { timestamp: 'last_edited_time', direction: 'descending' }],
          page_size: 3,
        })
        const rows = (q.results || []).map((p) => ({
          title: plain(p.properties?.Decision?.title) || plain(p.properties?.Name?.title) || '(untitled)',
          status: selectName(p.properties?.Status),
          confidence: selectName(p.properties?.Confidence),
          date: p.properties?.Date?.date?.start || '',
          url: p.url || '',
        }))
        log(`steering: decisions ${rows.length}`)
        return { rows, error: '' }
      } catch (err) {
        return { rows: [], error: fix(err.status, '🧠 Decisions (Notion)') + (err.status ? '' : ` — ${err.message}`) }
      }
    })
  }

  // ── U20: the rows the prospect plots stand on — one GET a poll at most, the whole table, every stage.
  // Stale-while-revalidate: GET /world must stay instant (the page gives it seconds), so a stale answer is
  // handed back at once and refreshed in the background; the first call, with nothing yet, waits.
  let prospectRefresh = null
  async function prospectRows() {
    const hit = caches.get('prospects')
    const fresh = hit && now() - hit.at < (hit.value?.error ? ERROR_MS : PROSPECTS_MS)
    if (fresh) return hit.value
    if (hit) {
      prospectRefresh ||= readProspects().finally(() => (prospectRefresh = null))
      return hit.value
    }
    return prospectRefresh || (prospectRefresh = readProspects().finally(() => (prospectRefresh = null)))
  }
  async function readProspects() {
    const stages = (await substrate.read()).deal_pipeline_stages || []
    let value = { rows: [], stages, error: '' }
    if (!cfg.airtableToken) value.error = 'AIRTABLE_TOKEN is not set in .env'
    else {
      try {
        const records = []
        let offset = ''
        do {
          const url = `https://api.airtable.com/v0/${cfg.airtableBaseId}/${PIPELINE_TABLE}?pageSize=100${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`
          const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.airtableToken}` } })
          const json = (res.ok ? await res.json() : await res.json().catch(() => ({})))
          if (!res.ok) throw new Error(fixAirtable(res.status))
          for (const r of json.records || []) records.push({ ...r, baseId: cfg.airtableBaseId })
          offset = json.offset || ''
        } while (offset)
        const t = now()
        value.rows = records.map((r) => pipelineRow(r, stages, t)).map(({ id, name, stage, stageIndex, open, won, lost, days, clientIds, url }) => ({ id, name, stage, stageIndex, open, won, lost, days, clientIds, url }))
      } catch (err) {
        value.error = err.message
      }
    }
    caches.set('prospects', { at: now(), value })
    return value
  }

  async function all() {
    const [p, m, d] = await Promise.all([pipeline(), milestoneBoard(), decisions()])
    return { at: new Date(now()).toISOString(), pipeline: p, milestones: m, decisions: d }
  }

  return { pipeline, milestoneBoard, decisions, all, prospectRows, _caches: caches }
}
