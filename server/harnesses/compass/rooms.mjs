/**
 * Room panels (U31, ES-6.6) — one read-only model per room, served by the sidecar as GET /rooms, each
 * panel its own 5-minute cache (surfaces.stale), nothing editable, an empty panel names its fix. The
 * Steering Room of U19 is retired: its three panels live here (pipeline → strategy room, the milestone
 * board → workshop and corner office, the last decisions → board room). U20's warmth is a column.
 *
 * What each room reads (GET, or the one guarded data-source query):
 *   board-room        🧠 Decisions — Pending (the requests standing here), 🟡 Working (folders), next review dates
 *   strategy-room     Pipeline "Active pipeline" rows in the view's order with stage and warmth; Research briefs with "Handoff ready"
 *                     (NOTION_DS_RESEARCH — property names from the source's schema, notion-rows.mjs, 2026-09-07)
 *   marketing-studio  ✍️ Content week wall Sun–Thu (NOTION_DS_CONTENT); signatures pending = the content_status requests
 *   research-lab      Research briefs by "Refresh due" (NOTION_DS_RESEARCH): due first, 🔄 Needs Refresh and overdue flagged
 *   finance-office    Airtable Finance (table resolved by name): unpaid, overdue, paid, this month
 *   integration-yard  Integrations with open drift findings — "Drift Status" = 🔴 Drift detected (NOTION_DS_INTEGRATIONS); the
 *                     unchecked ones counted; every page listed with status, platform, mappings and last drift check
 *   workshop          Active Build projects with their next milestone; the Delivery-type skills as benches
 *   records-office    automations and connectors (substrate v2 — live 2026-09-07; SKIPPED:WORKER-NEEDED on a v1 body), the
 *                     silent skills, the last twenty ledger runs. ops_automations carries id, name, platform, trigger_desc,
 *                     updated_at and no status — none is read or shown; "last fire" comes only from a rollup that names the
 *                     automation (Gate Reconciliation Sweep ← LAST_GATE_RECONCILIATION.finished_at, Run Governance Sweep ←
 *                     LAST_RUN_GOVERNANCE.finished_at); next fire and missed are SKIPPED:WORKER-NEEDED by field name.
 *                     ops_mcp_connectors carries id, service, via, updated_at and no status — rows are keyed by service.
 *   corner-office     today's Big 3 (✅ Tasks, NOTION_DS_TASKS — Status "🎯 Today" and the Big 3 priority, both matched by option
 *                     name from the source's own schema, never assumed), the four numbers (rollups.LAST_RUN_GOVERNANCE — null
 *                     until the first Saturday 05:30 sweep: the panel says "not yet", never zeros) and LAST_GATE_RECONCILIATION's
 *                     last run (finished_at, gates checked, still open), the milestone heat; the in-tray is the overlay's own list
 * A name that is set but unreadable (Notion 404 — the database is not shared with the integration) names itself on its
 * panel (SKIPPED:ENV — <name> is set but unreadable: …); an absent name says SKIPPED:ENV — set <name>.
 * Skills are rows in their room by ops_skills.type with the pack's overrides; each row is lit (a run live),
 * dark (idle), dusty (silent 30 d and wanted) or red (failed 24 h). Annex III: a row is a skill, never a person.
 */
import { roomForSkill, roomsOf } from './pack.mjs'
import { nextMilestone } from './steering.mjs'
import { PANEL_MS } from './surfaces.mjs'
import { DECISIONS, envSources, unreadableNote } from './notion-sources.mjs'
import { titleOf, selectName, dateStart, multiNames, relationIds } from './notion.mjs'
import { researchRow, needsRefresh, integrationRow, isDriftOpen, isUnchecked } from './notion-rows.mjs'
import { withTimeout } from './health.mjs'

const DAY_MS = 24 * 3600 * 1000
const str = (v) => (typeof v === 'string' ? v.trim() : '')
export const SKIP = Object.freeze({
  env: (name) => `SKIPPED:ENV — set ${name} in .env`,
  worker: (what) => `SKIPPED:WORKER-NEEDED — ${what} arrives with /world/substrate v2 (Prompt B-2)`,
  field: (what, fields) => `SKIPPED:WORKER-NEEDED — ${what}: /world/substrate v2 carries no ${fields}`,
})
/** The four numbers before the first Run Governance sweep has written LAST_RUN_GOVERNANCE (Saturday 05:30 Muscat). */
export const NOT_YET = 'not yet — first Run Governance sweep Saturday 05:30'
export const isV2 = (sub) => Number(sub?.version) >= 2

/** Pure: the first clause of a trigger description (they run to paragraphs in ops_automations), for a row's small text. */
export const triggerClause = (desc, max = 96) => { const first = str(desc).split(/(?<=[.!?])\s|\s—\s|\n/)[0].trim(); return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first }

/**
 * Pure: ops_automations → rows for the records office. No status is read (the table has none). "last fire" only where a
 * rollup names the automation; next fire and missed are not in the substrate (SKIP.field says which fields).
 */
export function automationRows(sub) {
  if (!isV2(sub)) return { rows: [], skipped: SKIP.worker('automations (next fire, last fire, missed)'), missing: '' }
  const r = sub.rollups || {}
  const lastFireOf = (name) => (/gate reconciliation/i.test(name) ? str(r.LAST_GATE_RECONCILIATION?.finished_at) : /run governance/i.test(name) ? str(r.LAST_RUN_GOVERNANCE?.finished_at) : '')
  const rows = (sub.automations || []).filter((a) => a && (str(a.name) || str(a.id))).map((a) => ({ id: str(a.id), name: str(a.name) || str(a.id), platform: str(a.platform), trigger: triggerClause(a.trigger_desc), lastFire: lastFireOf(str(a.name)), updated: str(a.updated_at).slice(0, 10) })).sort((a, b) => a.name.localeCompare(b.name))
  return { rows, skipped: '', missing: SKIP.field('next fire and missed', 'schedule or fire fields on ops_automations (next_run_at, last_run_at, missed)') }
}

/** Pure: ops_mcp_connectors → rows keyed by service (never by name — the table has no name); no status is read or shown. */
export function connectorRows(sub) {
  if (!isV2(sub)) return { rows: [], skipped: SKIP.worker('connectors') }
  const byService = new Map()
  for (const c of sub.connectors || []) {
    const service = str(c?.service)
    if (!service) continue
    const row = { key: service, service, via: str(c.via), updated: str(c.updated_at).slice(0, 10), ids: [str(c.id)].filter(Boolean) }
    const have = byService.get(service)
    if (have) { have.ids.push(...row.ids); if (row.updated > have.updated) { have.updated = row.updated; have.via = row.via || have.via } } else byService.set(service, row)
  }
  return { rows: [...byService.values()].sort((a, b) => a.service.localeCompare(b.service)), skipped: '' }
}

/**
 * Pure: the four numbers (unattended share, failure rate, median time-to-tap, open gates) from rollups.LAST_RUN_GOVERNANCE
 * and the last gate reconciliation from rollups.LAST_GATE_RECONCILIATION. A null LAST_RUN_GOVERNANCE is "not yet" (the first
 * Saturday 05:30 sweep writes it) — never zeros, never an empty panel. The four keys are read by the names the rollup is
 * expected to carry; a key it does not carry reads "—" and the panel says which.
 */
export function fourNumbers(sub) {
  if (!isV2(sub)) return { skipped: SKIP.worker('the four numbers (LAST_RUN_GOVERNANCE) and LAST_GATE_RECONCILIATION') }
  const r = sub.rollups || {}
  const g = r.LAST_RUN_GOVERNANCE && typeof r.LAST_RUN_GOVERNANCE === 'object' ? r.LAST_RUN_GOVERNANCE : null
  const pick = (o, names) => { for (const n of names) if (o && o[n] != null && o[n] !== '') return { value: o[n], key: n }; return { value: null, key: '' } }
  const keys = { unattendedShare: ['unattended_share', 'unattended_share_pct', 'unattended'], failureRate: ['failure_rate', 'failure_rate_pct', 'failures'], medianTimeToTap: ['median_time_to_tap', 'median_time_to_tap_minutes', 'median_ttt', 'time_to_tap_median'], openGates: ['open_gates', 'gates_open', 'open'] }
  const numbers = {}
  const unnamed = []
  for (const [k, names] of Object.entries(keys)) { const { value, key } = pick(g, names); numbers[k] = value; if (g && !key) unnamed.push(names[0]) }
  const rec = r.LAST_GATE_RECONCILIATION && typeof r.LAST_GATE_RECONCILIATION === 'object' ? r.LAST_GATE_RECONCILIATION : null
  return {
    skipped: '',
    ready: Boolean(g),
    notYet: g ? '' : NOT_YET,
    ...numbers,
    governanceAt: g ? str(g.finished_at || g.at) : '',
    unnamed, // keys the rollup did not carry under an expected name (shown as — with a note)
    reconciliation: rec ? { at: str(rec.finished_at || rec.at), gatesChecked: Number(rec.gates_checked) || 0, stillOpen: Number(rec.still_open) || 0, resolved: Array.isArray(rec.resolved) ? rec.resolved.length : Number(rec.resolved) || 0, couldNotRead: Array.isArray(rec.could_not_read) ? rec.could_not_read.length : 0, runId: str(rec.run_id) } : null,
  }
}

/** Pure: a Date's local calendar day as YYYY-MM-DD (toISOString would give the UTC day — the wall was a day early east of Greenwich, seen 2026-09-07). */
export const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
/** Pure: the week wall — Sun–Thu of the current local week (Muscat's working week), each day's cards by their date. */
export function weekWall(items, now = Date.now()) {
  const d = new Date(now); const sun = new Date(d); sun.setDate(d.getDate() - d.getDay()); sun.setHours(12, 0, 0, 0)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'].map((name, i) => { const day = new Date(sun); day.setDate(sun.getDate() + i); const iso = localDay(day); return { name, date: iso, cards: (Array.isArray(items) ? items : []).filter((c) => c.date === iso) } })
}
/** Pure: the option of a select / status property whose name matches, from the data source's schema (never assumed). */
export function optionNamed(prop, re) {
  const t = prop?.type
  const options = t === 'select' || t === 'status' ? prop[t]?.options || [] : []
  const hit = options.find((o) => re.test(String(o?.name || '')))
  return hit ? { type: t, name: hit.name } : null
}
/** Pure: today's Big 3 from the Tasks rows — Status "🎯 Today" and the Big 3 priority, by the names the schema gave. */
export function big3Of(items, { today, big3 }) {
  const rows = (Array.isArray(items) ? items : []).filter((t) => t.status === today)
  return { rows: rows.filter((t) => t.priority === big3).slice(0, 3), today: rows.length }
}

/** Pure: warmth from days since last touch (U20's rule, now a column). */
export const warmthOf = (days) => (days == null || !Number.isFinite(days) ? 0.2 : days <= 7 ? 1.0 : days <= 30 ? 0.5 : 0.2)

/** Pure: the state of a skill row. */
export function skillState(name, { live = new Set(), failed = new Set(), silent = new Set(), wanted = new Set() } = {}) {
  if (failed.has(name)) return 'red'
  if (live.has(name)) return 'lit'
  if (silent.has(name) && wanted.has(name)) return 'dusty'
  return 'dark'
}

/** Pure: every Active skill as a row in its room. */
export function skillRows(skills, pack, states) {
  const rows = new Map()
  for (const s of Array.isArray(skills) ? skills : []) {
    if (!s || !str(s.name) || !/^active$/i.test(str(s.status))) continue
    const { room, source, wants } = roomForSkill(pack, s.name, s.type)
    if (!rows.has(room)) rows.set(room, [])
    rows.get(room).push({ name: s.name, type: str(s.type), state: skillState(s.name, states), placedBy: source, wants })
  }
  for (const list of rows.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

/** Pure: the wanted skills — the pack override names a wants value that an Active project's Tech Stack contains (ES-6.8). */
export function wantedSkills(pack, projects) {
  const stack = new Set()
  for (const p of Array.isArray(projects) ? projects : []) for (const t of p.techStack || []) stack.add(str(t).toLowerCase())
  const out = new Set()
  for (const [name, o] of Object.entries(pack?.skills?.overrides || {})) if (str(o?.wants) && stack.has(str(o.wants).toLowerCase())) out.add(name)
  return out
}

/** Pure: Airtable Finance records → the four buckets. Amounts in OMR ("Amount in OMR" formula, else "Amount OMR (Locked)"). */
export function financeBuckets(records, now = Date.now()) {
  const d = new Date(now)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const today = d.toISOString().slice(0, 10)
  const out = { unpaid: { n: 0, omr: 0, rows: [] }, overdue: { n: 0, omr: 0, rows: [] }, paid: { n: 0, omr: 0, rows: [] }, thisMonth: { n: 0, omr: 0, rows: [] } }
  const add = (b, r, f) => { b.n++; b.omr += Number(f['Amount in OMR'] ?? f['Amount OMR (Locked)'] ?? 0) || 0; if (b.rows.length < 12) b.rows.push({ id: r.id, name: str(f['Entry Name']) || str(f['Invoice Number']) || r.id, status: str(f.Status), amount: Number(f.Amount) || 0, currency: str(f.Currency), omr: Number(f['Amount in OMR'] ?? 0) || 0, due: str(f['Due Date']), issued: str(f['Issue Date']), url: r.url || '' }) }
  for (const r of Array.isArray(records) ? records : []) {
    const f = r?.fields || {}
    const status = str(f.Status)
    const due = str(f['Due Date'])
    const income = Number(f['Is Income']) === 1 || /^income/i.test(str(f.Type))
    if (/^overdue$/i.test(status) || (/^invoiced$/i.test(status) && due && due < today)) add(out.overdue, r, f)
    else if (/^invoiced$/i.test(status)) add(out.unpaid, r, f)
    else if (/^(paid|received)$/i.test(status)) add(out.paid, r, f)
    if (income && str(f['Issue Date']).startsWith(month)) add(out.thisMonth, r, f)
  }
  for (const b of Object.values(out)) b.omr = Math.round(b.omr * 100) / 100
  return { month, ...out }
}

export function createRooms(cfg, { surfaces, substrate, steering, pack, lastScan, log = () => {}, fetchImpl: rawFetch = globalThis.fetch, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.readTimeoutMs ?? 10_000) // U37: a deadline on every read
  const env = envSources()
  const packNow = () => (typeof pack === 'function' ? pack() : pack)
  const scan = () => (typeof lastScan === 'function' ? lastScan() : null) || { runs: new Map(), threads: [], projects: [], silent: [], live: new Set(), failed: new Set() }

  /** The Finance table, resolved by name through the base's metadata (GET /v0/meta/bases/<base>/tables), cached. */
  const financeTable = () =>
    surfaces.stale('finance-table', 60 * 60_000, async () => {
      if (!cfg.airtableToken) throw new Error('AIRTABLE_TOKEN is not set in .env')
      const res = await fetchImpl(`https://api.airtable.com/v0/meta/bases/${cfg.airtableBaseId}/tables`, { headers: { Authorization: `Bearer ${cfg.airtableToken}` } })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`airtable meta ${res.status}: ${body.error?.type || ''}`.trim())
      const t = (body.tables || []).find((x) => /^finance$/i.test(x.name))
      if (!t) throw new Error('no table named Finance in the base')
      log(`rooms: Finance table resolved by name → ${t.id}`)
      return { id: t.id, name: t.name }
    }, null)

  const skillsWithStates = async () => {
    const s = scan()
    const projects = s.projects?.length ? s.projects : await surfaces.activeProjects()
    const wanted = wantedSkills(packNow(), projects)
    return skillRows((await substrate.read()).skills, packNow(), { live: s.live, failed: s.failed, silent: new Set(s.silent), wanted })
  }

  async function boardRoom() {
    return surfaces.stale('room:board', PANEL_MS, async () => {
      const rows = await surfaces.client.query(DECISIONS, { sorts: [{ property: 'Date', direction: 'descending' }], page_size: 100 }, { maxPages: 5 })
      const map = (p) => ({ id: p.id, title: titleOf(p), status: selectName(p.properties?.Status), confidence: selectName(p.properties?.Confidence), date: dateStart(p.properties?.Date), reviewDue: dateStart(p.properties?.['Review Due']), category: selectName(p.properties?.Category), url: p.url || '' })
      const all = rows.map(map)
      const working = all.filter((d) => /working/i.test(d.confidence) && !/superseded/i.test(d.status))
      const today = new Date(now()).toISOString().slice(0, 10)
      const dated = all.filter((d) => d.reviewDue && !/superseded/i.test(d.status)).sort((a, b) => a.reviewDue.localeCompare(b.reviewDue))
      // the next review dates: upcoming first (ten), the overdue ones counted
      const reviews = dated.filter((d) => d.reviewDue >= today).slice(0, 10)
      const overdueReviews = dated.filter((d) => d.reviewDue < today).length
      const recent = all.filter((d) => /^(active|pending)$/i.test(d.status)).slice(0, 3)
      return { working, reviews, overdueReviews, recent, total: all.length, error: '' }
    }, { working: [], reviews: [], overdueReviews: 0, recent: [], total: 0, error: 'reading…' }).then(async (panel) => {
      // the Pending list is the requests standing here: the same 15-s read the threads come from, never a 5-min copy
      const pending = await surfaces.pendingDecisions()
      return { ...panel, pending: pending.map((d) => ({ id: d.id, title: d.title, status: d.status, confidence: d.confidence, date: d.at ? new Date(d.at).toISOString().slice(0, 10) : '', reviewDue: d.reviewDue, url: d.url })) }
    })
  }

  async function strategyRoom() {
    const p = await steering.pipeline()
    const rows = (p.hot || []).map((r) => ({ ...r, warmth: warmthOf(r.days) }))
    const research = env.RESEARCH ? await researchBriefs() : { rows: [], skipped: SKIP.env('NOTION_DS_RESEARCH') }
    return { pipeline: { rows, view: p.view, error: p.error }, research: { rows: research.rows.filter((b) => b.handoff), skipped: research.skipped || '', error: research.error || '' } }
  }

  const researchBriefs = () =>
    surfaces.stale('room:research', PANEL_MS, async () => {
      const rows = await surfaces.client.query(env.RESEARCH, { page_size: 100 }, { maxPages: 3 }).catch((err) => { throw new Error(unreadableNote('RESEARCH', err)) })
      return { rows: rows.map(researchRow), error: '' }
    }, { rows: [], error: 'reading…' })

  async function marketingStudio() {
    const s = scan()
    const signatures = (s.threads || []).filter((t) => t.kind === 'request' && (t.request === 'content' || t.gates?.some((g) => g.surface === 'content_status'))).map((t) => ({ id: t.id, title: t.gates?.[0]?.gate || t.title, url: t.ref?.url || '', at: t.gateAt || t.lastActivityAt }))
    if (!env.CONTENT) return { week: [], signatures, skipped: SKIP.env('NOTION_DS_CONTENT') }
    const wall = await surfaces.stale('room:content', PANEL_MS, async () => {
      const rows = await surfaces.client.query(env.CONTENT, { page_size: 100 }).catch((err) => { throw new Error(unreadableNote('CONTENT', err)) })
      // the wall's date is the plan (Target Publish Date), else the fact (Published Date); the channel is the primary one
      const items = rows.map((p) => { const pr = p.properties || {}; const date = dateStart(pr['Target Publish Date']) || dateStart(pr['Published Date']) || dateStart(pr['Publish Date'] || pr.Date); return { id: p.id, title: titleOf(p), status: selectName(pr.Status), channel: selectName(pr['Primary channel'] || pr.Channel) || multiNames(pr.Channel).join('/'), date, url: p.url || '' } })
      return { week: weekWall(items, now()), byStatus: items.reduce((m, c) => ((m[c.status || '∅'] = (m[c.status || '∅'] || 0) + 1), m), {}), error: '' }
    }, { week: [], byStatus: {}, error: 'reading…' })
    return { ...wall, signatures, skipped: '' }
  }

  async function researchLab() {
    if (!env.RESEARCH) return { rows: [], skipped: SKIP.env('NOTION_DS_RESEARCH') }
    const r = await researchBriefs()
    const today = localDay(new Date(now())) // the local calendar day, as the week wall (a UTC day flagged a brief 4 h late east of Greenwich)
    const rows = r.rows.map((b) => ({ ...b, due: needsRefresh(b, today) })).sort((a, b) => Number(b.due) - Number(a.due) || (a.refreshDue || '9999').localeCompare(b.refreshDue || '9999'))
    return { rows, due: rows.filter((b) => b.due).length, error: r.error, skipped: '' }
  }

  async function financeOffice() {
    return surfaces.stale('room:finance', PANEL_MS, async () => {
      const t = await financeTable()
      if (!t) throw new Error('Finance table not resolved')
      const fields = ['Entry Name', 'Status', 'Amount', 'Currency', 'Amount in OMR', 'Due Date', 'Issue Date', 'Paid Date', 'Is Income', 'Type', 'Invoice Number', 'Entry Class'].map((f) => `&fields%5B%5D=${encodeURIComponent(f)}`).join('')
      const records = (await surfaces.airtableAll(t.id, fields)).map((r) => ({ ...r, url: `https://airtable.com/${cfg.airtableBaseId}/${t.id}/${r.id}` }))
      return { table: t.id, ...financeBuckets(records, now()), error: '' }
    }, { table: '', unpaid: { n: 0, omr: 0, rows: [] }, overdue: { n: 0, omr: 0, rows: [] }, paid: { n: 0, omr: 0, rows: [] }, thisMonth: { n: 0, omr: 0, rows: [] }, error: 'reading…' })
  }

  async function integrationYard() {
    if (!env.INTEGRATIONS) return { rows: [], skipped: SKIP.env('NOTION_DS_INTEGRATIONS') }
    return surfaces.stale('room:integrations', PANEL_MS, async () => {
      const rows = await surfaces.client.query(env.INTEGRATIONS, { page_size: 100 }, { maxPages: 3 }).catch((err) => { throw new Error(unreadableNote('INTEGRATIONS', err)) })
      const items = rows.map(integrationRow).sort((a, b) => Number(isDriftOpen(b)) - Number(isDriftOpen(a)) || a.title.localeCompare(b.title))
      return { rows: items, open: items.filter(isDriftOpen), unchecked: items.filter(isUnchecked).length, error: '', skipped: '' }
    }, { rows: [], open: [], unchecked: 0, error: 'reading…', skipped: '' })
  }

  async function workshop() {
    const projects = await surfaces.activeProjects()
    const build = projects.filter((p) => /build/i.test(p.engagementType || '')).map((p) => ({ id: p.id, name: p.name, clientName: p.clientName, internal: p.internal, url: p.url, done: (p.milestones?.list || []).filter((m) => m.done).length, total: (p.milestones?.list || []).length, next: nextMilestone(p.milestones?.list || []) }))
    const skills = await skillsWithStates()
    return { projects: build, benches: skills.get('workshop') || [], error: '' }
  }

  async function recordsOffice() {
    const s = scan()
    const sub = await substrate.read()
    const runs = [...(s.runs?.values?.() || [])].sort((a, b) => b.lastAt - a.lastAt).slice(0, 20).map((r) => ({ id: r.id, skill: r.skill, client: r.client || '', state: r.terminal === 'run_failed' ? 'failed' : r.gates.some((g) => !g.passed) ? 'waiting' : r.terminal === 'run_completed' ? 'completed' : s.live.has(r.skill) ? 'running' : 'idle', at: r.lastAt, gates: r.gates.length, artifacts: r.artifacts.length }))
    const skills = await skillsWithStates()
    // the ! requests from 🩺 System Health stand here (ES-6.3); an unreadable source says so by name instead of an empty list
    const health = { rows: (s.threads || []).filter((t) => t.kind === 'request' && t.request === 'health').map((t) => ({ id: t.id, title: t.gitBranch === 'open finding' ? (t.preview || '').split(' — ')[0] : t.title, url: t.ref?.url || '', at: t.createdAt })), skipped: env.SYSTEM_HEALTH ? '' : SKIP.env('NOTION_DS_SYSTEM_HEALTH'), error: surfaces.readErrors?.()['system-health'] || '' }
    return {
      health,
      automations: automationRows(sub),
      connectors: connectorRows(sub),
      silent: { rows: (s.silent || []).map((name) => ({ name, dusty: skills.get('records-office')?.some((r) => r.name === name && r.state === 'dusty') || [...skills.values()].some((list) => list.some((r) => r.name === name && r.state === 'dusty')) })), of: (sub.skills || []).filter((k) => /^active$/i.test(str(k.status))).length },
      runs, rows: skills.get('records-office') || [], error: '',
    }
  }

  async function cornerOffice() {
    const sub = await substrate.read()
    // the in-tray (U14) — the request threads standing on the scan, as the tray lists them
    const s = scan()
    const tray = (s.threads || []).filter((t) => t.kind === 'request').map((t) => ({ id: t.id, title: t.title, skill: t.skill, zone: t.project, at: t.gateAt || t.lastActivityAt, url: t.ref?.url || '', badge: t.badge })).sort((a, b) => (a.badge === b.badge ? 0 : a.badge === '!' ? -1 : 1) || a.at - b.at)
    let big3 = { rows: [], skipped: SKIP.env('NOTION_DS_TASKS') }
    if (env.TASKS) {
      big3 = await surfaces.stale('room:tasks', PANEL_MS, async () => {
        // the option names come from the source's schema (GET /v1/data_sources/<id>): "🎯 Today" and the Big 3 priority
        const schema = await surfaces.client.get(`data_sources/${env.TASKS}`).catch((err) => { throw new Error(unreadableNote('TASKS', err)) })
        const today = optionNamed(schema.properties?.Status, /today/i)
        const big = optionNamed(schema.properties?.Priority, /big 3/i)
        if (!today || !big) throw new Error(`NOTION_DS_TASKS: no ${!today ? 'Status option matching "Today"' : 'Priority option matching "Big 3"'} in the source's schema`)
        const filter = { property: 'Status', [today.type]: { equals: today.name } }
        const rows = await surfaces.client.query(env.TASKS, { filter, page_size: 100 }, { maxPages: 3 })
        const items = rows.map((p) => { const pr = p.properties || {}; return { id: p.id, title: titleOf(p), status: selectName(pr.Status), priority: selectName(pr.Priority), url: p.url || '' } })
        return { ...big3Of(items, { today: today.name, big3: big.name }), names: { today: today.name, big3: big.name }, skipped: '', error: '' }
      }, { rows: [], skipped: '', error: 'reading…' })
    }
    const numbers = fourNumbers(sub)
    const heat = await steering.milestoneBoard()
    return { tray, big3, numbers, heat: { rows: heat.rows || [], error: heat.error || '' }, error: '' }
  }

  const readers = { 'board-room': boardRoom, 'strategy-room': strategyRoom, 'marketing-studio': marketingStudio, 'research-lab': researchLab, 'finance-office': financeOffice, 'integration-yard': integrationYard, workshop, 'records-office': recordsOffice, 'corner-office': cornerOffice }

  async function one(id) {
    const fn = readers[id]
    if (!fn) return null
    try {
      const skills = id === 'workshop' || id === 'records-office' ? null : await skillsWithStates().catch(() => new Map())
      const data = await fn()
      return { id, at: new Date(now()).toISOString(), substrateVersion: (await substrate.read()).version || 1, ...data, skills: skills ? skills.get(id) || [] : data.rows || data.benches || [] }
    } catch (err) {
      return { id, at: new Date(now()).toISOString(), error: err.message || String(err), skills: [] }
    }
  }
  async function all() {
    const out = {}
    for (const r of roomsOf(packNow())) if (readers[r.id]) out[r.id] = await one(r.id)
    return { at: new Date(now()).toISOString(), rooms: out, missingEnv: Object.entries(env).filter(([, v]) => !v).map(([k]) => `NOTION_DS_${k}`) }
  }
  return { one, all, readers: Object.keys(readers) }
}
