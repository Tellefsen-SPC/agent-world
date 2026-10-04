/**
 * The adapter's one Notion client (M2b B5). Two verbs and nothing else:
 *   get(path)             GET /v1/<path>
 *   query(dataSource, …)  POST /v1/data_sources/<id>/query — the one write-shaped read Notion forces on a
 *                         reader (there is no GET that lists rows). Allowed ONLY for an id listed in
 *                         notion-sources.mjs; any other id throws before a request is built. The write guard
 *                         in test/invariants.test.mjs allows exactly the one `method` line below, in this file.
 * Never a PATCH, PUT or DELETE. Never a body on a GET. Tokens stay in cfg.
 */
import { isAllowed } from './notion-sources.mjs'
import { withTimeout } from './health.mjs'

export const NOTION_VERSION = '2025-09-03'

export function createNotion(cfg, { fetchImpl: rawFetch = globalThis.fetch, env = process.env } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.readTimeoutMs ?? 10_000) // U37: a deadline on every read
  const headers = () => {
    if (!cfg.notionToken) throw Object.assign(new Error('NOTION_TOKEN is not set in .env'), { status: 0 })
    return { Authorization: `Bearer ${cfg.notionToken}`, 'Notion-Version': NOTION_VERSION }
  }
  const fail = (res, json, what) => Object.assign(new Error(json.message || json.code || `notion ${res.status} on ${what}`), { status: res.status, code: json.code || '' })

  async function get(path) {
    const res = await fetchImpl(`https://api.notion.com/v1/${path}`, { headers: headers() })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw fail(res, json, path)
    return json
  }

  /** One page of a data source query. `body` is Notion's own filter / sorts / page_size / start_cursor. */
  async function queryPage(dataSource, body = {}) {
    const id = String(dataSource || '').trim()
    if (!isAllowed(id, env)) throw Object.assign(new Error(`data source ${id.slice(0, 8)}… is not one the adapter may query (compass/notion-sources.mjs)`), { status: 0, refused: true })
    const init = { headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    init.method = 'POST' // the allowed line: a data-source query, on an allowed id, and nothing else
    const res = await fetchImpl(`https://api.notion.com/v1/data_sources/${id}/query`, init)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw fail(res, json, `data_sources/${id.slice(0, 8)}…/query`)
    return json
  }

  /** Every row a query yields, following has_more up to `maxPages` pages. */
  async function query(dataSource, body = {}, { maxPages = 10 } = {}) {
    const results = []
    let cursor = ''
    for (let i = 0; i < maxPages; i++) {
      const page = await queryPage(dataSource, cursor ? { ...body, start_cursor: cursor } : body)
      results.push(...(page.results || []))
      if (!page.has_more || !page.next_cursor) break
      cursor = page.next_cursor
    }
    return results
  }

  return { get, query, queryPage }
}

// ── property readers (pure) ────────────────────────────────────────────────────────────────
export const plain = (rich) => (Array.isArray(rich) ? rich.map((t) => t?.plain_text || '').join('') : '')
export const titleOf = (page) => {
  const t = Object.values(page?.properties || {}).find((p) => p?.type === 'title')
  return plain(t?.title)
}
export const selectName = (prop) => {
  const t = prop?.type
  return t === 'select' || t === 'status' ? prop[t]?.name || '' : ''
}
export const multiNames = (prop) => (prop?.type === 'multi_select' ? (prop.multi_select || []).map((o) => o?.name || '').filter(Boolean) : [])
export const relationIds = (prop) => (prop?.type === 'relation' ? (prop.relation || []).map((r) => r?.id).filter(Boolean) : [])
export const dateStart = (prop) => (prop?.type === 'date' ? prop.date?.start || '' : '')
export const urlOf = (prop) => (prop?.type === 'url' ? prop.url || '' : prop?.type === 'rich_text' ? plain(prop.rich_text) : '')
export const richText = (prop) => (prop?.type === 'rich_text' ? plain(prop.rich_text) : '')
export const filesOf = (prop) => (prop?.type === 'files' ? (prop.files || []).map((f) => f?.external?.url || f?.file?.url || '').filter(Boolean) : [])
