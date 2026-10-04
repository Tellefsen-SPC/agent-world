// Agent World — one in-flight read per cache key (docs/multiplayer.md step 5; docs/adr/0004). Concurrent callers on
// a cold or expired cache share one fetch: a cache expiring under ten viewers is one read of Compass, Notion or
// Airtable, not ten. Fakes only, counted.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { createSubstrate } = await import(path.join(root, 'server/harnesses/compass/substrate.mjs'))
const { createSpend } = await import(path.join(root, 'server/harnesses/compass/spend.mjs'))
const { createSurfaces } = await import(path.join(root, 'server/harnesses/compass/surfaces.mjs'))
const { createSteering } = await import(path.join(root, 'server/harnesses/compass/steering.mjs'))
const { createRooms } = await import(path.join(root, 'server/harnesses/compass/rooms.mjs'))
const { DECISIONS } = await import(path.join(root, 'server/harnesses/compass/notion-sources.mjs'))

const later = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms))
const reply = (body) => ({ ok: true, status: 200, json: async () => body })
/** A fake fetch that answers after a short wait (so concurrent callers overlap), counting calls by a key of the URL. */
function slowFetch(answer, keyOf = (url) => new URL(url).pathname) {
  const calls = new Map()
  const fetchImpl = async (url) => {
    const k = keyOf(String(url))
    calls.set(k, (calls.get(k) || 0) + 1)
    return later(15, reply(answer(String(url))))
  }
  return { fetchImpl, calls, count: (k) => calls.get(k) || 0, total: () => [...calls.values()].reduce((a, b) => a + b, 0) }
}
const cfgBase = { eventsBearerToken: 'zztest', readTimeoutMs: 1000, substrateCacheMs: 60_000, spendCacheMs: 60_000, spendWindowDays: 30 }

test('the substrate: concurrent reads on a cold cache share one GET /world/substrate, and so do reads on an expired one', async () => {
  let t = 1_000_000
  const f = slowFetch(() => ({ version: 1, at: 'x', clients: [{ name: 'ZZTEST Client' }], skills: [] }))
  const substrate = createSubstrate({ ...cfgBase, substrateUrl: 'https://compass.invalid/world/substrate' }, { fetchImpl: f.fetchImpl, now: () => t })
  const cold = await Promise.all([substrate.read(), substrate.read(), substrate.read()])
  assert.equal(f.total(), 1, 'three cold readers, one fetch')
  assert.ok(cold.every((v) => v === cold[0]) && cold[0].clients.length === 1, 'all three get the answer')
  await substrate.read()
  assert.equal(f.total(), 1, 'fresh: cached')
  t += 61_000
  const expired = await Promise.all([substrate.read(), substrate.read(), substrate.read()])
  assert.equal(f.total(), 2, 'three readers on an expired cache, one more fetch')
  assert.ok(expired.every((v) => v === expired[0]))
})

test('spend and today: concurrent reads on a cold or expired cache share one Worker read per key; different windows are different keys', async () => {
  let t = 1_000_000
  const f = slowFetch((url) => (url.includes('/ledger/cost') ? { days: 1, by_town: [] } : { at: 'x', window_days: 30, totals: {}, by_client: [] }), (url) => { const u = new URL(url); return u.pathname + u.search })
  const spend = createSpend({ ...cfgBase, spendUrl: 'https://compass.invalid/world/spend', ledgerCostUrl: 'https://compass.invalid/ledger/cost' }, { fetchImpl: f.fetchImpl, now: () => t })
  await Promise.all([spend.read(), spend.read(), spend.read(), spend.read({ window: 7 }), spend.read({ window: 7 }), spend.today(), spend.today(), spend.today()])
  assert.equal(f.count('/world/spend?window=30'), 1)
  assert.equal(f.count('/world/spend?window=7'), 1)
  assert.equal(f.count('/ledger/cost?days=1'), 1)
  t += 61_000
  await Promise.all([spend.read(), spend.read(), spend.today(), spend.today()])
  assert.equal(f.count('/world/spend?window=30'), 2)
  assert.equal(f.count('/ledger/cost?days=1'), 2)
})

test('the 5-minute panels: stale() hands every concurrent cold caller the one read\'s answer, never the fallback, and an expired key is refreshed once', async () => {
  let t = 1_000_000
  const surfaces = createSurfaces({ ...cfgBase, notionToken: 'zztest', airtableToken: 'zztest', airtableBaseId: 'appZZTEST' }, { fetchImpl: async () => reply({}), now: () => t })
  let reads = 0
  const fn = () => (reads++, later(15, { rows: ['ZZTEST row'], error: '' }))
  const fallback = { rows: [], error: 'reading…' }
  const cold = await Promise.all([surfaces.stale('zz', 300_000, fn, fallback), surfaces.stale('zz', 300_000, fn, fallback), surfaces.stale('zz', 300_000, fn, fallback)])
  assert.equal(reads, 1, 'one read')
  assert.deepEqual(cold.map((v) => v.rows), [['ZZTEST row'], ['ZZTEST row'], ['ZZTEST row']], 'no cold caller is handed the fallback')
  t += 300_001
  await Promise.all([surfaces.stale('zz', 300_000, fn, fallback), surfaces.stale('zz', 300_000, fn, fallback), surfaces.stale('zz', 300_000, fn, fallback)])
  await later(30)
  assert.equal(reads, 2, 'an expired key is refreshed once, however many callers')
})

test('milestone progress: concurrent reads of one project share one Notion read of the project page', async () => {
  const f = slowFetch((url) => (url.includes('/pages/') ? { properties: { Milestones: { relation: [] } } } : {}))
  const surfaces = createSurfaces({ ...cfgBase, notionToken: 'zztest' }, { fetchImpl: f.fetchImpl })
  const id = '3d1c0af9c97481ce8a25f4bdeadd54ab'
  await Promise.all([surfaces.progress(id), surfaces.progress(id), surfaces.recentDone(id), surfaces.progress(id.replace(/^(.{8})(.{4})/, '$1-$2-'))])
  assert.equal(f.total(), 1, 'one GET of the page for four concurrent callers (dashed and undashed are one key)')
})

test('the steering panels: concurrent cold reads of the pipeline and the milestone board each read Airtable / Notion once', async () => {
  const f = slowFetch((url) => (url.includes('api.airtable.com') ? { records: [] } : { results: [], has_more: false }), (url) => { const u = new URL(url); return u.host + u.pathname + (u.searchParams.get('view') ? ':view' : '') })
  const substrate = { read: async () => ({ deal_pipeline_stages: ['Lead'] }) }
  const surfaces = { milestones: async () => ({ list: [], value: 0.05 }) }
  const steering = createSteering({ ...cfgBase, notionToken: 'zztest', airtableToken: 'zztest', airtableBaseId: 'appZZTEST' }, { surfaces, substrate, fetchImpl: f.fetchImpl })
  const p = await Promise.all([steering.pipeline(), steering.pipeline(), steering.pipeline(), steering.milestoneBoard(), steering.milestoneBoard()])
  const airtable = [...f.calls].filter(([k]) => k.startsWith('api.airtable.com')).reduce((a, [, n]) => a + n, 0)
  const notion = [...f.calls].filter(([k]) => k.startsWith('api.notion.com')).reduce((a, [, n]) => a + n, 0)
  assert.equal(airtable, 2, 'the pipeline is two Airtable lists (all rows, then the view) — once, not once per caller')
  assert.equal(notion, 1, 'the milestone board is one Notion query')
  assert.ok(p[0] === p[1] && p[1] === p[2], 'every caller gets the one answer')
})

test('a room panel: concurrent cold reads of the board room share one Notion query, and none is handed "reading…"', async () => {
  const f = slowFetch((url) => (url.includes('/data_sources/') ? { results: [{ id: 'zz-decision', properties: { Name: { type: 'title', title: [{ plain_text: 'ZZTEST decision' }] }, Status: { type: 'select', select: { name: 'Active' } } } }], has_more: false } : { records: [] }), (url) => new URL(url).pathname)
  const cfg = { ...cfgBase, notionToken: 'zztest', airtableToken: 'zztest', airtableBaseId: 'appZZTEST' }
  const surfaces = createSurfaces(cfg, { fetchImpl: f.fetchImpl })
  surfaces.pendingDecisions = async () => [] // the 15-s request read is not the panel's cache; kept out of the count
  const substrate = { read: async () => ({ version: 1, skills: [] }) }
  const rooms = createRooms(cfg, { surfaces, substrate, steering: {}, pack: () => ({}), lastScan: () => null, fetchImpl: f.fetchImpl })
  const panels = await Promise.all([rooms.one('board-room'), rooms.one('board-room'), rooms.one('board-room')])
  assert.equal(f.count(`/v1/data_sources/${DECISIONS}/query`), 1, 'one Decisions query for three viewers')
  for (const panel of panels) {
    assert.equal(panel.error, '', 'no panel reads "reading…"')
    assert.equal(panel.total, 1)
  }
})
