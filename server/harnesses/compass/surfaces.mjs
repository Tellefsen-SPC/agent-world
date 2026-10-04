/**
 * Compass adapter — surface reads: milestone progress (U4) and the gate cross-check (U6).
 *
 * Read only, and mechanically so: every request in this file is a GET (npm test proves it).
 * Every failure degrades to the safe answer — the progress floor, the ? still shown — and warns
 * once a minute. The world never hides a ? because a read failed, and it never writes gate_passed:
 * the sweep and the pollers own that. This file only stops the world lying in the meantime.
 *
 * Surfaces cross-checked (SPEC.md §4.6):
 *   pending_approval  Airtable HQ row     resolved when Status is Approved / Sent / Rejected
 *   decision          Notion Decision     resolved when Status has moved on from Pending
 *   content_status    Notion Content row  resolved when Status has moved on from In Review
 *                     (added 2026-09-06: Christoffer signed a draft and the ? stayed until the
 *                      20:00 poller — the poller owns the write, not the read)
 *   class_b_gate, client_gate — no surface to read; never checked.
 *
 * M2b (U28) adds the still map's surface reads, all through the one Notion client (compass/notion.mjs,
 * data-source queries only for the ids compass/notion-sources.mjs allows) or Airtable GETs:
 *   activeProjects()    Notion Projects with Status Active → fixtures (5 min); the client's name is resolved
 *                       through the client page's "Airtable Client ID" → Airtable Clients "Client Name" (the
 *                       same name ops_clients carries), else the page title without its " — Client Wiki" tail
 *   pendingApprovals()  Airtable Pending Approval rows at Status "Pending Approval" (15 s, stale-while-revalidate:
 *                       a request leaves within one poll of the tap)
 *   pendingDecisions()  🧠 Decisions at Status Pending (15 s, stale-while-revalidate)
 *   contentInReview()   ✍️ Content rows In Review — only when NOTION_DS_CONTENT is set (else null: SKIPPED:ENV)
 *   systemHealthOpen()  🩺 System Health open findings — only when NOTION_DS_SYSTEM_HEALTH is set (else null)
 *   clientNames()       Airtable Clients record id → Client Name (5 min)
 */
import { createNotion, titleOf, selectName, multiNames, relationIds, dateStart, richText } from './notion.mjs'
import { PROJECTS, DECISIONS, envSources, unreadableNote } from './notion-sources.mjs'
import { healthRow, isOpenFinding, HEALTH_OPEN_FILTER, HEALTH_SORT } from './notion-rows.mjs'
import { withTimeout } from './health.mjs'
export const PENDING_APPROVAL_TABLE = 'tbleRnuppbr0wpsaM'
export const CLIENTS_TABLE = 'tbl3JYj8WwS3kSrN4'
export const REQUEST_MS = 15_000
export const PANEL_MS = 5 * 60_000

const DONE = /delivered|done|accepted|complete/i // 🎯 Engagement Milestones → Status "🟢 Delivered"
const PA_RESOLVED = /^(approved|sent|rejected)$/i
const CROSS = new Set(['pending_approval', 'decision', 'content_status'])

/** 32-hex or dashed → dashed uuid; '' when it is neither (project ids arrive both ways in the ledger). */
export function dash(id) {
  const h = String(id || '').replace(/-/g, '')
  return /^[0-9a-f]{32}$/i.test(h) ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : ''
}
/** The page id at the end of any Notion URL shape (app.notion.com/p/<id>, notion.so/<slug>-<id>, ?pvs=…). */
export function notionId(url) {
  const s = String(url || '').split(/[?#]/)[0]
  const m = s.match(/([0-9a-f]{32})$/i) || s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m ? dash(m[1]) : ''
}
/** base / table / record out of an Airtable record URL, with or without a view segment. */
export function airtableRef(url) {
  const m = String(url || '').match(/(app[A-Za-z0-9]+)\/(tbl[A-Za-z0-9]+)(?:\/viw[A-Za-z0-9]+)?\/(rec[A-Za-z0-9]+)/)
  return m ? { base: m[1], table: m[2], record: m[3] } : null
}

/** Pure: can this gate be verified on a surface at all? (needs a cross-checkable surface and a real link) */
export const crossCheckable = (gate) => Boolean(gate && CROSS.has(gate.surface) && /^https?:\/\//.test(gate.ref_url || ''))

export function createSurfaces(cfg, { fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.readTimeoutMs ?? 10_000) // U37: a deadline on every read
  const warned = new Map()
  const warn = (key, msg) => {
    const t = now()
    if (t - (warned.get(key) || 0) > 60_000) {
      warned.set(key, t)
      console.warn('bot-crossing: compass —', msg)
    }
  }

  const client = createNotion(cfg, { fetchImpl })
  async function notion(path) {
    try {
      return await client.get(path)
    } catch (err) {
      const hint = err.status === 404 ? ' (share the database with the "Tellefsen - Agent world" integration)' : ''
      throw new Error(`notion ${err.status || ''} on ${path}: ${err.code || err.message || ''} ${hint}`.trim())
    }
  }
  async function airtable(pathAndQuery) {
    if (!cfg.airtableToken) throw new Error('AIRTABLE_TOKEN is not set in .env')
    const res = await fetchImpl(`https://api.airtable.com/v0/${cfg.airtableBaseId}/${pathAndQuery}`, { headers: { Authorization: `Bearer ${cfg.airtableToken}` } })
    const body = (res.ok ? await res.json() : await res.json().catch(() => ({})))
    if (!res.ok) throw new Error(`airtable ${res.status} on ${pathAndQuery.split('?')[0]}: ${body.error?.type || body.error || ''}`.trim())
    return body
  }
  /** Every record of a table (or a view / formula filter), following offset. */
  async function airtableAll(table, query = '') {
    const out = []
    let offset = ''
    do {
      const page = await airtable(`${table}?pageSize=100${query}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`)
      out.push(...(page.records || []))
      offset = page.offset || ''
    } while (offset)
    return out
  }
  /**
   * A cache with two lifetimes: a good answer lives `ms`; a stale one is handed back at once and refreshed behind it.
   * A failed read names its error on the fallback (an object gains `error`) and is retried after ERROR_MS, never
   * held for the full period (an empty panel names its fix).
   */
  const ERROR_MS = 30_000
  const swr = new Map() // key → { at, value, refreshing, failed }
  const withError = (fallback, err) => (fallback && typeof fallback === 'object' && !Array.isArray(fallback) && !(fallback instanceof Map) ? { ...fallback, error: err.message || String(err) } : fallback)
  /** The reads whose last refresh failed: key → message (the panels name an unreadable source instead of showing an empty list). */
  const readErrors = () => Object.fromEntries([...swr].filter(([, v]) => v.failed).map(([k, v]) => [k, v.error || 'unavailable']))
  async function stale(key, ms, fn, fallback) {
    const hit = swr.get(key)
    if (hit && now() - hit.at < (hit.failed ? ERROR_MS : ms)) return hit.value
    const refresh = () => fn().then((value) => { swr.set(key, { at: now(), value, failed: false }); return value }).catch((err) => { warn(key, `${key} unavailable — ${err.message}`); const v = hit && !hit.failed ? hit.value : withError(fallback, err); swr.set(key, { at: now(), value: v, failed: true, error: err.message || String(err) }); return v })
    if (hit) {
      if (!hit.refreshing) hit.refreshing = refresh().finally(() => (hit.refreshing = null))
      return hit.value
    }
    const entry = { at: 0, value: fallback, refreshing: null }
    swr.set(key, entry)
    entry.refreshing = refresh().finally(() => (entry.refreshing = null))
    return entry.refreshing
  }

  // ── U4: 🎯 Engagement Milestones done ÷ total for the run's project, 5-min cache ──────────
  const progressCache = new Map() // dashed project id → { at, value, doneAt: newest last_edited_time of a Done milestone }
  /** One read per project per 5 min: progress (U4) and the newest time a milestone was edited while Done (U17's ✓). */
  async function milestones(projectId) {
    const id = dash(projectId)
    if (!id) return { value: 0.05, doneAt: 0, list: [] }
    const hit = progressCache.get(id)
    if (hit && now() - hit.at < 5 * 60_000) return hit
    let value = 0.05
    let doneAt = 0
    let list = []
    try {
      const page = await notion(`pages/${id}`)
      const rel = page.properties?.Milestones
      let ids = (rel?.relation || []).map((r) => r.id)
      if (rel?.has_more && rel.id) {
        const more = await notion(`pages/${id}/properties/${encodeURIComponent(rel.id)}?page_size=100`)
        ids = (more.results || []).map((r) => r.relation?.id).filter(Boolean)
      }
      if (ids.length) {
        const pages = await Promise.all(
          ids.map((m) =>
            notion(`pages/${m}`)
              .then((p) => {
                const pr = p.properties || {}
                const title = Object.values(pr).find((x) => x?.type === 'title')
                return {
                  id: m,
                  name: (title?.title || []).map((t) => t.plain_text).join('') || m,
                  status: selectName(pr.Status),
                  edited: Date.parse(p.last_edited_time) || 0,
                  committed: Date.parse(pr['Committed Date']?.date?.start || '') || 0,
                  sequence: typeof pr.Sequence?.number === 'number' ? pr.Sequence.number : null,
                  url: p.url || '',
                }
              })
              .catch(() => ({ id: m, name: m, status: '', edited: 0, committed: 0, sequence: null, url: '' }))
          )
        )
        list = pages.map((p) => ({ ...p, done: DONE.test(p.status) }))
        const done = list.filter((p) => p.done)
        value = Math.max(0.05, done.length / ids.length)
        doneAt = done.reduce((m, p) => Math.max(m, p.edited), 0)
      }
      log(`progress ${id}: ${value} (${ids.length} milestones)`)
    } catch (err) {
      warn(`progress:${id}`, `milestone progress unavailable for project ${id} — ${err.message}`)
    }
    const entry = { at: now(), value, doneAt, list }
    progressCache.set(id, entry)
    return entry
  }
  const progress = async (projectId) => (await milestones(projectId)).value
  /** U17: a milestone of this project was Done and edited within the window (Notion's last_edited_time is the only clock it offers). */
  const recentDone = async (projectId, windowMs = 24 * 3600 * 1000) => {
    const { doneAt } = await milestones(projectId)
    return Boolean(doneAt) && now() - doneAt <= windowMs
  }

  // ── U6: has the surface already resolved this gate? ─────────────────────────────────────────

  async function readResolved(gate) {
    if (gate.surface === 'pending_approval') {
      const ref = airtableRef(gate.ref_url)
      if (!ref) return false
      if (!cfg.airtableToken) throw new Error('AIRTABLE_TOKEN is not set in .env')
      const res = await fetchImpl(`https://api.airtable.com/v0/${ref.base}/${ref.table}/${ref.record}`, {
        headers: { Authorization: `Bearer ${cfg.airtableToken}` },
      })
      const body = (res.ok ? await res.json() : await res.json().catch(() => ({})))
      if (!res.ok) throw new Error(`airtable ${res.status} on ${ref.record}: ${body.error?.type || body.error || ''}`.trim())
      return PA_RESOLVED.test(String(body.fields?.Status || '').trim())
    }
    const id = notionId(gate.ref_url)
    if (!id) return false
    const status = selectName((await notion(`pages/${id}`)).properties?.Status)
    if (!status) return false
    if (gate.surface === 'decision') return !/pending/i.test(status)
    if (gate.surface === 'content_status') return !/in review/i.test(status)
    return false
  }

  // Keyed by run_id + gate (+ surface + ref_url), never by ref_url alone: a Pending Approval row that
  // is re-armed for a NEW run (same record, new gate_waiting) must be read again, or its ? would stay
  // hidden until the process restarts (defect found 2026-09-07 at the M1 rechecks). Within one run a
  // gate seen resolved stays resolved — no surface read every poll for it.
  const gateCache = new Map() // run_id|gate|surface|ref_url → { at, resolved }
  async function gateResolved(gate) {
    if (!crossCheckable(gate)) return false
    const key = `${gate.run_id || ''}|${gate.gate || ''}|${gate.surface}|${gate.ref_url}`
    const hit = gateCache.get(key)
    if (hit && (hit.resolved || now() - hit.at < 5_000)) return hit.resolved
    let resolved = false
    try {
      resolved = await readResolved(gate)
      if (resolved) log(`gate resolved on its surface: ${key}`)
    } catch (err) {
      warn(`gate:${key}`, `cross-check unavailable for ${gate.surface} — ${err.message}`)
    }
    gateCache.set(key, { at: now(), resolved })
    return resolved
  }

  // ── M2b: the still map's surface reads ───────────────────────────────────────────────────
  const clientNames = () =>
    stale('clients', PANEL_MS, async () => {
      const map = new Map()
      for (const r of await airtableAll(CLIENTS_TABLE, '&fields%5B%5D=Client+Name')) map.set(r.id, String(r.fields?.['Client Name'] || '').trim())
      return map
    }, new Map())

  const clientPageCache = new Map() // Notion client page id → { at, name }
  /** The client's name as ops_clients carries it: the page's Airtable Client ID → Airtable Clients name, else the title without " — Client Wiki". */
  async function clientNameOf(pageId, names) {
    const hit = clientPageCache.get(pageId)
    if (hit && now() - hit.at < PANEL_MS) return hit.name
    let name = ''
    try {
      const page = await notion(`pages/${pageId}`)
      const rec = richText(page.properties?.['Airtable Client ID']).trim()
      name = (rec && names.get(rec)) || titleOf(page).replace(/\s*[—–-]\s*client wiki\s*$/i, '').trim()
    } catch (err) {
      warn(`client:${pageId}`, `client page ${pageId} unreadable — ${err.message}`)
    }
    clientPageCache.set(pageId, { at: now(), name })
    return name
  }
  const INTERNAL = /tellefsen/i
  /** Active Notion Projects → [{ id, name, clientName, internal, techStack, engagementType, url, edited, milestones }] (5 min). */
  const activeProjects = () =>
    stale('projects', PANEL_MS, async () => {
      const rows = await client.query(PROJECTS, { filter: { property: 'Status', select: { equals: 'Active' } }, page_size: 100 })
      const names = await clientNames()
      const out = []
      for (const p of rows) {
        const pr = p.properties || {}
        const clientIds = relationIds(pr.Client)
        const clientName = clientIds.length ? await clientNameOf(clientIds[0], names) : ''
        out.push({
          id: p.id, name: titleOf(p), clientName, internal: !clientName || INTERNAL.test(clientName),
          techStack: multiNames(pr['Tech Stack']), engagementType: selectName(pr['Engagement Type']), status: selectName(pr.Status),
          url: p.url || '', edited: Date.parse(p.last_edited_time) || 0,
          milestones: await milestones(p.id),
        })
      }
      log(`projects: ${out.length} Active`)
      return out
    }, [])

  const paUrl = (id) => `https://airtable.com/${cfg.airtableBaseId}/${PENDING_APPROVAL_TABLE}/${id}`
  /** Pending Approval rows at Status "Pending Approval" → requests (15 s, stale-while-revalidate). */
  const pendingApprovals = () =>
    stale('pending-approvals', REQUEST_MS, async () => {
      const names = await clientNames()
      const records = await airtableAll(PENDING_APPROVAL_TABLE, `&filterByFormula=${encodeURIComponent("{Status}='Pending Approval'")}&fields%5B%5D=Action+Title&fields%5B%5D=Status&fields%5B%5D=Client&fields%5B%5D=Action+Type&fields%5B%5D=One-Line+Summary&fields%5B%5D=Created+Date`)
      return records.map((r) => ({
        id: r.id, title: String(r.fields?.['Action Title'] || '').trim(), type: String(r.fields?.['Action Type'] || '').trim(), summary: String(r.fields?.['One-Line Summary'] || '').trim(),
        clientName: (Array.isArray(r.fields?.Client) && names.get(r.fields.Client[0])) || '', at: Date.parse(r.fields?.['Created Date'] || r.createdTime || '') || 0, url: paUrl(r.id),
      }))
    }, [])

  /** 🧠 Decisions at Status Pending (or a ⚑ awaiting-confirm option) → requests (15 s, stale-while-revalidate). */
  const pendingDecisions = () =>
    stale('pending-decisions', REQUEST_MS, async () => {
      // Status is a select: an exact equals filter server-side (every Pending row, however old); a ⚑ "awaiting confirm"
      // option does not exist in the schema today (Active / Pending / Superseded) — it would need its own equals clause here.
      const rows = await client.query(DECISIONS, { filter: { property: 'Status', select: { equals: 'Pending' } }, sorts: [{ property: 'Date', direction: 'descending' }], page_size: 100 }, { maxPages: 5 })
      return rows.map((p) => ({
        id: p.id, title: titleOf(p), status: selectName(p.properties?.Status), confidence: selectName(p.properties?.Confidence),
        at: Date.parse(dateStart(p.properties?.Date) || p.created_time || '') || 0, reviewDue: dateStart(p.properties?.['Review Due']), url: p.url || '',
      }))
    }, [])

  const env = envSources()
  /** ✍️ Content rows In Review → requests; null when NOTION_DS_CONTENT is not set (SKIPPED:ENV). Schema-agnostic: the Status option is matched by name. */
  const contentInReview = () =>
    !env.CONTENT ? Promise.resolve(null) : stale('content-in-review', REQUEST_MS, async () => {
      const rows = await client.query(env.CONTENT, { page_size: 100 }).catch((err) => { throw new Error(unreadableNote('CONTENT', err)) })
      return rows.filter((p) => /in review/i.test(selectName(p.properties?.Status))).map((p) => ({ id: p.id, title: titleOf(p), status: selectName(p.properties?.Status), at: Date.parse(p.last_edited_time) || 0, url: p.url || '' }))
    }, [])
  /**
   * 🩺 System Health open findings → ! requests; null when NOTION_DS_SYSTEM_HEALTH is not set. Filtered server-side on
   * Status = Open (2026-09-07: the source holds 500+ rows, nearly all Fixed — an unfiltered first page missed the open
   * ones), newest Detected At first, shaped by notion-rows.healthRow (Finding · Severity · Source · Detected At).
   */
  const systemHealthOpen = () =>
    !env.SYSTEM_HEALTH ? Promise.resolve(null) : stale('system-health', REQUEST_MS, async () => {
      const rows = await client.query(env.SYSTEM_HEALTH, { filter: HEALTH_OPEN_FILTER, sorts: HEALTH_SORT, page_size: 100 }, { maxPages: 3 }).catch((err) => { throw new Error(unreadableNote('SYSTEM_HEALTH', err)) })
      return rows.map(healthRow).filter(isOpenFinding)
    }, [])

  return { progress, recentDone, milestones, gateResolved, crossCheckable, activeProjects, pendingApprovals, pendingDecisions, contentInReview, systemHealthOpen, clientNames, notion, airtable, airtableAll, stale, readErrors, client, _cache: { progressCache, gateCache, swr } }
}
