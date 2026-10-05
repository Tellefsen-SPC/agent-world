// Agent World — the approval layer's surface through the harness under the client preset (confirmation 1): a run that
// waits only on a proposal the client cannot tap shows nothing of it, and is still not counted running — in the strip's
// counts and in the `live` set the room panels read — while a live run with no gate is. A stand-in for the Worker in
// place of fetch; its own file because the harness reads its config (WORLD_VIEWER_PRESET) at import. Synthetic data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const substrate = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/substrate.zztest.json'), 'utf8'))
const WORKER = 'https://zztest-worker.example'
const PROPOSAL = '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5'
const now = new Date(Date.now() - 60_000).toISOString()
const run = (id) => `d4d4d4d4-0000-4000-8000-0000000000${id}`
const ev = (id, runId, skill, event_type, payload = {}) => ({ id, run_id: runId, at: now, event_type, skill, trigger: 'cowork_scheduled', client: 'ZZTEST Client', project: null, actor: 'zztest-proposer', payload })
const events = [
  // waits only on a proposal: blocked on a person, and the client may not see it
  ev('e1', run('01'), 'zztest-waiter', 'run_started'),
  ev('e2', run('01'), 'zztest-waiter', 'gate_waiting', { surface: 'approval', gate: `approval:${PROPOSAL}` }),
  // live, no gate at all
  ev('e3', run('02'), 'zztest-builder', 'run_started'),
]

test('under client: a run waiting on a hidden proposal is no thread, carries no trace, and is not in the live set; a live run is', { timeout: 15000 }, async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.origin === WORKER && url.pathname === '/ledger/scan') return json(200, { events, rows: [] })
    if (url.origin === WORKER && url.pathname === '/world/substrate') return json(200, substrate)
    return json(404, { error: 'not found' })
  }
  try {
    for (const k of Object.keys(process.env)) if (/^(NOTION_|AIRTABLE_TOKEN$|WORLD_STREAM$|WORLD_ASK_BEARER$)/.test(k)) delete process.env[k]
    process.env.EVENTS_URL = `${WORKER}/events`
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer-client'
    process.env.WORLD_VIEWER_PRESET = 'client'
    process.env.WORLD_OVERLAY_PORT = '0'
    process.env.WORLD_STREAM = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    assert.equal(_internals.viewer.preset, 'client')
    const threads = await harness.scanThreads()
    assert.ok(!threads.some((t) => t.id === run('01')), 'not the client\'s to tap → no thread')
    for (const s of ['approval:', '"approval"', 'console', PROPOSAL]) assert.ok(!JSON.stringify(threads).includes(s), `nothing of the proposal: ${s}`)
    const scan = _internals.lastScan()
    assert.deepEqual([...scan.live].sort(), ['zztest-builder'], 'the live set: the live run, never the one waiting on a person')
    assert.equal(_internals.signals().counts.running, 1, 'the strip counts one running')
  } finally {
    globalThis.fetch = realFetch
  }
})
