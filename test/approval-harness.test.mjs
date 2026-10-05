// Agent World — the approval layer's surface through the harness: an approval:<proposal id> gate on the ledger becomes a
// "? Approve · Compass" request that opens the Compass console at the Worker base EVENTS_URL names, and the console is
// never read. A stand-in for the Worker in place of fetch (EVENTS_URL must be https for the console link, so it is not
// a loopback server); its own file because the harness reads its config at import. Synthetic data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const substrate = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/substrate.zztest.json'), 'utf8'))
const WORKER = 'https://zztest-worker.example'
const PROPOSAL = '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5'
const CLOSED = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2910'
const now = new Date(Date.now() - 60_000).toISOString()
const run = (id) => `c3c3c3c3-0000-4000-8000-0000000000${id}`
const ev = (id, runId, event_type, payload = {}) => ({ id, run_id: runId, at: now, event_type, skill: 'approval-layer', trigger: 'cowork_scheduled', client: 'ZZTEST Client', project: null, actor: 'zztest-proposer', payload })
const events = [
  // a proposal waiting for an approver (the layer's own payload: surface, gate, ref = the proposal id; no ref_url)
  ev('e1', run('01'), 'run_started', { surface: 'approval' }),
  ev('e2', run('01'), 'gate_waiting', { surface: 'approval', gate: `approval:${PROPOSAL}`, ref: PROPOSAL }),
  // a gate whose name is not approval:<uuid> — still a ?, with nothing to open
  ev('e3', run('02'), 'run_started', { surface: 'approval' }),
  ev('e4', run('02'), 'gate_waiting', { surface: 'approval', gate: 'approval:../ledger/zztest' }),
  // a proposal already decided: the layer wrote its gate_passed, the ledger closes it, the world shows nothing
  ev('e5', run('03'), 'run_started', { surface: 'approval' }),
  ev('e6', run('03'), 'gate_waiting', { surface: 'approval', gate: `approval:${CLOSED}`, ref: CLOSED }),
  ev('e7', run('03'), 'gate_passed', { surface: 'approval', gate: `approval:${CLOSED}`, ref: CLOSED, result: 'approved' }),
]

test('an approval-layer gate is a "? Approve · Compass" request that opens the console under EVENTS_URL; a decided one is gone; the console is never fetched', { timeout: 15000 }, async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    seen.push(url.href)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.origin === WORKER && url.pathname === '/ledger/scan') return json(200, { events, rows: [] })
    if (url.origin === WORKER && url.pathname === '/world/substrate') return json(200, substrate)
    return json(404, { error: 'not found' })
  }
  try {
    for (const k of Object.keys(process.env)) if (/^(NOTION_|AIRTABLE_TOKEN$|WORLD_STREAM$|WORLD_ASK_BEARER$|WORLD_VIEWER_PRESET$)/.test(k)) delete process.env[k]
    process.env.EVENTS_URL = `${WORKER}/events`
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer-approval'
    process.env.WORLD_OVERLAY_PORT = '0'
    process.env.WORLD_STREAM = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    assert.equal(_internals.cfg.consoleProposalsUrl, `${WORKER}/console/proposals`, 'derived from EVENTS_URL')
    const threads = await harness.scanThreads()
    const byRun = new Map(threads.filter((t) => t.kind === 'request').map((t) => [t.id, t]))

    const waiting = byRun.get(run('01'))
    assert.ok(waiting, 'the waiting proposal is a request')
    assert.equal(waiting.title, '? Approve · Compass')
    assert.equal(waiting.badge, '?')
    assert.equal(waiting.gitBranch, 'approve in Compass')
    assert.equal(waiting.ref.url, `${WORKER}/console/proposals/${PROPOSAL}`, 'Open lands on the proposal in the console')
    assert.equal(waiting.gates[0].url, `${WORKER}/console/proposals/${PROPOSAL}`)
    assert.deepEqual(harness.openThread(waiting.ref), { ok: true, url: `${WORKER}/console/proposals/${PROPOSAL}` })

    const malformed = byRun.get(run('02'))
    assert.ok(malformed?.unread, 'a malformed name still waits on a human')
    assert.equal(malformed.ref.url, null, 'and opens nothing')
    assert.equal(malformed.gates[0].url, '')
    assert.equal(harness.openThread(malformed.ref).ok, false)

    assert.ok(!byRun.has(run('03')), 'a decided proposal leaves with its gate_passed, read from the ledger')
    assert.ok(!threads.some((t) => t.id === run('03')), 'no thread at all for it')

    assert.ok(seen.some((u) => u.startsWith(`${WORKER}/ledger/scan?since=`)), 'the ledger was read')
    assert.ok(!seen.some((u) => u.includes('/console/')), 'the console is a link for a human, never a read')
  } finally {
    globalThis.fetch = realFetch
  }
})
