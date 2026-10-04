// Agent World — U7 through the harness: an event on the Worker's GET /events/stream drops the adapter's scan cache, so
// the next poll reads the ledger instead of a cached answer; an event during a scan makes that scan's answer stale too;
// a stream that is down or hanging never holds up a poll and is not a "Compass unavailable". One local server stands in
// for the Worker (ledger scan, substrate, stream). Its own file: the harness reads its config at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a stream event drops the scan cache; a stream that is down or hanging never holds up a poll and is not an outage', { timeout: 20000 }, async () => {
  let scans = 0
  let scanDelayMs = 0
  let streamMode = 'open' // open | 503 | hang
  const streams = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/ledger/scan') {
      // the poll's scan reads the 14-day window; the 30-day background scan (U17) is not a poll and is not counted
      if (Date.now() - Date.parse(url.searchParams.get('since')) < 20 * 864e5) scans += 1
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events: [], rows: [] }))
      }, scanDelayMs)
      return
    }
    if (url.pathname === '/world/substrate') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ version: 1, at: 'x', clients: [], skills: [] }))
    }
    if (url.pathname === '/events/stream') {
      if (streamMode === 'hang') return streams.push(res) // accepts, never answers
      if (streamMode === '503') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        return res.end('{"error":"busy"}')
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('retry: 1000\n: connected — polling every 2s\n\n')
      streams.push(res)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const push = (n) => {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    for (const s of streams) s.write(`id: 2026-10-04T08:00:0${n}Z|${id}\nevent: ledger\ndata: ${JSON.stringify({ id, run_id: 'zztest-run', event_type: 'gate_waiting', skill: 'zztest-approver', client: 'ZZTEST Client', at: '2026-10-04T08:00:00Z', payload: {} })}\n\n`)
  }
  try {
    // No surface but the local stand-in: whatever the shell carries, no Notion or Airtable token reaches the harness.
    for (const k of Object.keys(process.env)) if (/^(NOTION_|AIRTABLE_TOKEN$|WORLD_STREAM$)/.test(k)) delete process.env[k]
    process.env.EVENTS_URL = `http://127.0.0.1:${server.address().port}/events`
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer'
    process.env.WORLD_OVERLAY_PORT = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    assert.equal(_internals.cfg.streamUrl, `http://127.0.0.1:${server.address().port}/events/stream`, 'derived from EVENTS_URL')

    await harness.detect()
    await sleep(50)
    assert.equal(streams.length, 0, 'never started on its own under npm test')

    await harness.scanThreads()
    await harness.scanThreads()
    assert.equal(scans, 1, 'the second poll is served from the 5 s cache')

    _internals.startStream()
    await until(() => streams.length === 1, 3000, 'the subscription')
    await until(() => _internals.realtime().state === 'open', 3000, 'the stream to open')
    push(1)
    await until(() => _internals.realtime().events === 1, 3000, 'the event')
    await harness.scanThreads()
    assert.equal(scans, 2, 'the event dropped the cache: this poll read the ledger again, inside the 5 s')

    // an event that lands while a scan is in flight: that scan's answer is stale, so the next poll reads again
    push(2)
    await until(() => _internals.realtime().events === 2, 3000, 'the second event')
    scanDelayMs = 150
    const inFlight = harness.scanThreads()
    await sleep(40)
    push(3)
    await until(() => _internals.realtime().events === 3, 3000, 'the third event')
    await inFlight
    assert.equal(scans, 3)
    scanDelayMs = 0
    await harness.scanThreads()
    assert.equal(scans, 4, 'the event during the scan made its answer stale')
    assert.equal(_internals.signals().compass.ok, true)

    // the stream goes down: polls carry on, and Compass is not called unavailable
    streamMode = '503'
    for (const s of streams.splice(0)) s.destroy()
    await until(() => _internals.realtime().state === 'waiting' && /503/.test(_internals.realtime().error), 5000, 'the stream to fail')
    _internals.invalidate()
    await harness.scanThreads()
    assert.equal(scans, 5)
    assert.equal(_internals.signals().compass.ok, true, 'a stream that is down is not an outage')
    assert.deepEqual(_internals.signals().compass.failing, [])

    // the stream hangs: a poll is not held up by it
    streamMode = 'hang'
    _internals.invalidate()
    const started = Date.now()
    await harness.scanThreads()
    assert.ok(Date.now() - started < 1000, 'the poll does not wait on the stream')
    assert.ok(!JSON.stringify(_internals.realtime()).includes('zztest-bearer'), 'no token in the stream record')
  } finally {
    globalThis.__awStream?.stop?.()
    for (const s of streams) s.destroy?.()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})
