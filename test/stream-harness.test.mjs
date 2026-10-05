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

    // The cache counts from when the scan finished. A scan that takes longer than the cache window used to be stale
    // the moment it landed (it was stamped with its start), so the next poll scanned again and a nudge changed nothing.
    _internals.cfg.scanCacheMs = 400
    scanDelayMs = 600
    await harness.scanThreads()
    assert.equal(scans, 1)
    await sleep(150)
    await harness.scanThreads()
    assert.equal(scans, 1, 'a poll 150 ms after a 600 ms scan finished is served from the 400 ms cache')
    scanDelayMs = 0
    _internals.cfg.scanCacheMs = 5000
    await harness.scanThreads()
    assert.equal(scans, 1, 'the second poll is served from the 5 s cache')
    assert.deepEqual([_internals.stream().nudges, _internals.stream().nudgedScans, _internals.stream().connected], [0, 0, false])

    _internals.startStream()
    await until(() => streams.length === 1, 3000, 'the subscription')
    await until(() => _internals.stream().state === 'open', 3000, 'the stream to open')
    push(1)
    await until(() => _internals.stream().nudges === 1, 3000, 'the event')
    assert.equal(_internals.stream().connected, true)
    assert.ok(_internals.stream().lastEventAt)
    await harness.scanThreads()
    assert.equal(scans, 2, 'the event dropped the cache: this poll read the ledger again, inside the 5 s')
    assert.equal(_internals.stream().nudgedScans, 1, 'a scan that only the nudge caused')

    // an event that lands while a scan is in flight: that scan's answer is stale, so the next poll reads again
    push(2)
    await until(() => _internals.stream().nudges === 2, 3000, 'the second event')
    scanDelayMs = 150
    const inFlight = harness.scanThreads()
    await sleep(40)
    push(3)
    await until(() => _internals.stream().nudges === 3, 3000, 'the third event')
    await inFlight
    assert.equal(scans, 3)
    scanDelayMs = 0
    await harness.scanThreads()
    assert.equal(scans, 4, 'the event during the scan made its answer stale')
    assert.equal(_internals.stream().nudgedScans, 3, 'each of the three early scans is counted')
    await harness.scanThreads()
    assert.equal(scans, 4, 'and with no new event, the cache serves the next poll')
    assert.equal(_internals.signals().compass.ok, true)

    // nudgedScans counts only a scan that starts before the un-nudged cache would have run out. A short cache stands
    // in for the 5 s; every poll below comes after that moment, so none is early — whatever events arrived.
    _internals.cfg.scanCacheMs = 120
    await sleep(150)
    await harness.scanThreads() // a fresh scan; the cache now runs to finish + 120 ms
    const counted = _internals.stream().nudgedScans
    let n = 4
    // (a) an event while the cache is fresh, then a poll after it would have run out anyway: not early
    push(n++)
    await until(() => _internals.stream().nudges === n - 1, 3000, 'the event')
    await sleep(200)
    await harness.scanThreads()
    assert.equal(_internals.stream().nudgedScans, counted, 'a poll after natural expiry is not counted, though an event came first')
    // (b) an event during a scan, then a poll after that scan's finish + the cache: not early either
    scanDelayMs = 80
    await sleep(150)
    const during = harness.scanThreads()
    await sleep(20)
    push(n++)
    await until(() => _internals.stream().nudges === n - 1, 3000, 'the event during the scan')
    await during
    scanDelayMs = 0
    await sleep(200)
    await harness.scanThreads()
    assert.equal(_internals.stream().nudgedScans, counted, 'nor after an event during a scan, once the cache would have run out')
    // (c) the reviewer's scene: one viewer polling slower than scan + cache, events landing during scans and between
    // them. No scan is early, so the count stays where it was — as it must for a nudge that drops nothing.
    scanDelayMs = 40
    for (let i = 0; i < 7; i++) {
      const poll = harness.scanThreads()
      if (i % 2 === 0) { await sleep(10); push(n++) } // during the scan
      await poll
      if (i % 2 === 1) { await sleep(30); push(n++) } // while the cache is fresh
      await until(() => _internals.stream().nudges === n - 1, 3000, 'each event')
      await sleep(220) // past finish + 120 ms
    }
    scanDelayMs = 0
    assert.equal(_internals.stream().nudgedScans, counted, 'seven polls, every one after natural expiry: zero early scans')
    // and the early read still counts when it is one: an event on a fresh cache, then a poll at once
    await harness.scanThreads()
    push(n++)
    await until(() => _internals.stream().nudges === n - 1, 3000, 'the last event')
    await harness.scanThreads()
    assert.equal(_internals.stream().nudgedScans, counted + 1, 'a poll inside the window after an event is early, and counted')
    _internals.cfg.scanCacheMs = 5000

    // the stream goes down: polls carry on, and Compass is not called unavailable
    streamMode = '503'
    for (const s of streams.splice(0)) s.destroy()
    await until(() => _internals.stream().state === 'waiting' && /503/.test(_internals.stream().error), 5000, 'the stream to fail')
    const before = scans
    _internals.invalidate()
    await harness.scanThreads()
    assert.equal(scans, before + 1, 'the poll reads the ledger as usual')
    assert.equal(_internals.signals().compass.ok, true, 'a stream that is down is not an outage')
    assert.deepEqual(_internals.signals().compass.failing, [])

    // the stream hangs: a poll is not held up by it
    streamMode = 'hang'
    _internals.invalidate()
    const started = Date.now()
    await harness.scanThreads()
    assert.ok(Date.now() - started < 1000, 'the poll does not wait on the stream')
    const signal = _internals.stream()
    assert.deepEqual(Object.keys(signal), ['enabled', 'connected', 'state', 'since', 'lastEventAt', 'nudges', 'nudgedScans', 'reconnects', 'error'])
    assert.ok(!JSON.stringify(signal).includes('zztest-bearer'), 'no token in the stream record')
    assert.ok(!/zztest-run|zztest-approver|ZZTEST Client/.test(JSON.stringify(signal)), 'no run, skill or client in it — counts and times only')
  } finally {
    globalThis.__awStream?.stop?.()
    for (const s of streams) s.destroy?.()
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})
