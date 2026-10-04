// U37 (the Engineering spine's U8) — the world when Compass is down: a deadline on every read, one retry for a failure that
// passes, and a notice on the strip instead of a world that silently goes stale. No network: fakes throughout,
// and the harness test points at a port nothing listens on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { withTimeout, createHealth } = await import(path.join(root, 'server/harnesses/compass/health.mjs'))
const { createLedgerClient } = await import(path.join(root, 'server/harnesses/compass/supabase.mjs'))
const { compassNotice } = await import(path.join(root, 'overlay/signals.mjs'))

const cfg = { ledgerUrl: 'https://compass.invalid/ledger/scan', eventsBearerToken: 'tst', ledgerTimeoutMs: 50 }
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
/** A fetch that never answers on its own — only the deadline ends it. */
const hanging = (url, init = {}) =>
  new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))

test('a read that does not answer gives up at its deadline, and says which route', { timeout: 5000 }, async () => {
  const started = Date.now()
  await assert.rejects(withTimeout(hanging, 40)('https://compass.invalid/world/substrate'), /\/world\/substrate did not answer within 40 ms/)
  assert.ok(Date.now() - started < 1000)
})

test('the ledger scan retries a 503 once and then succeeds', { timeout: 5000 }, async () => {
  const calls = []
  const answers = [reply(503, { error: 'busy' }), reply(200, { events: [{ id: 'e' }], rows: [] })]
  const ledger = createLedgerClient(cfg, { fetchImpl: async (url) => (calls.push(url), answers.shift()), retryDelayMs: 1 })
  const out = await ledger.scanSince('2026-10-04T00:00:00Z')
  assert.equal(calls.length, 2)
  assert.deepEqual(out.events, [{ id: 'e' }])
})

test('the ledger scan does not retry what will not pass — a 401, or a timeout', { timeout: 5000 }, async () => {
  let calls = 0
  const unauthorised = createLedgerClient(cfg, { fetchImpl: async () => (calls++, reply(401, { error: 'unauthorized' })), retryDelayMs: 1 })
  await assert.rejects(unauthorised.scanSince('2026-10-04T00:00:00Z'), /ledger read 401: unauthorized/)
  assert.equal(calls, 1)

  calls = 0
  const slow = createLedgerClient(cfg, { fetchImpl: (url, init) => (calls++, hanging(url, init)), retryDelayMs: 1 })
  await assert.rejects(slow.scanSince('2026-10-04T00:00:00Z'), /did not answer within 50 ms/)
  assert.equal(calls, 1)
})

test('the ledger scan gives up after a second network failure', { timeout: 5000 }, async () => {
  let calls = 0
  const ledger = createLedgerClient(cfg, { fetchImpl: async () => { calls++; throw new TypeError('fetch failed') }, retryDelayMs: 1 })
  await assert.rejects(ledger.scanSince('2026-10-04T00:00:00Z'), /fetch failed/)
  assert.equal(calls, 2)
})

test('the deadline covers the body: a Worker that sends its headers and then stalls is an outage, not a hang', { timeout: 5000 }, async () => {
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write('{"events":[') // …and nothing more
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/ledger/scan`
  try {
    const started = Date.now()
    await assert.rejects(createLedgerClient({ ...cfg, ledgerUrl: url, ledgerTimeoutMs: 150 }).scanSince('2026-10-04T00:00:00Z'), (err) => err.name === 'TimeoutError' && /did not answer within 150 ms/.test(err.message))
    assert.ok(Date.now() - started < 2000)
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})

test('a long scan can be given its own deadline (the 30-day background scan)', { timeout: 5000 }, async () => {
  const ledger = createLedgerClient(cfg, { fetchImpl: (url, init) => hanging(url, init) })
  await assert.rejects(ledger.scanSince('2026-09-04T00:00:00Z', { timeoutMs: 80 }), /within 80 ms/)
})

test('the health record: down since the first failure, last good kept, reset by a good scan', { timeout: 5000 }, () => {
  let t = Date.parse('2026-10-04T08:00:00Z')
  const health = createHealth({ now: () => t })
  assert.equal(health.snapshot().ok, null)
  health.ok()
  t += 60_000
  health.fail(new Error('ledger read 502'))
  t += 60_000
  health.fail(new Error('ledger read 502'))
  assert.deepEqual(health.snapshot(), { ok: false, downSince: '2026-10-04T08:01:00.000Z', lastGoodAt: '2026-10-04T08:00:00.000Z', error: 'ledger read 502' })
  health.ok()
  assert.equal(health.snapshot().ok, true)
  assert.equal(health.snapshot().downSince, null)
})

test('the health record covers the substrate too: the world\'s map failing is an outage even while the ledger answers', { timeout: 5000 }, () => {
  let t = Date.parse('2026-10-04T08:00:00Z')
  const health = createHealth({ now: () => t })
  health.ok()
  health.ok('substrate')
  t += 60_000
  health.fail(new Error('fetch failed'), 'substrate')
  assert.deepEqual(health.snapshot(), { ok: false, downSince: '2026-10-04T08:01:00.000Z', lastGoodAt: '2026-10-04T08:00:00.000Z', error: 'substrate: fetch failed' })
  t += 60_000
  health.fail(new Error('ledger read 503'))
  assert.equal(health.snapshot().downSince, '2026-10-04T08:01:00.000Z', 'the earliest failure still standing')
  assert.match(health.snapshot().error, /ledger read 503; substrate: fetch failed|substrate: fetch failed; ledger read 503/)
  health.ok('substrate')
  health.ok()
  assert.equal(health.snapshot().ok, true)
})

test('the strip notice: nothing while Compass answers or the world is loading; a plain sentence when it does not', { timeout: 5000 }, () => {
  const timeOf = (iso) => iso.slice(11, 16)
  assert.equal(compassNotice({ ok: true }), null)
  assert.equal(compassNotice({ ok: null }), null)
  assert.equal(compassNotice(undefined), null)
  const down = compassNotice({ ok: false, downSince: '2026-10-04T08:01:00Z', lastGoodAt: '2026-10-04T08:00:00Z', error: 'ledger read 502' }, { timeOf })
  assert.equal(down.label, 'Compass unavailable')
  assert.equal(down.detail, 'since 08:01')
  assert.match(down.title, /last saw, at 08:00/)
  const never = compassNotice({ ok: false, downSince: '2026-10-04T08:01:00Z', lastGoodAt: null, error: 'x' }, { timeOf })
  assert.match(never.title, /Nothing has loaded yet/)
})

test('the harness against a dead Compass: no crash, no threads invented, and signals.compass says so', { timeout: 5000 }, async () => {
  // A port that was free a moment ago: the connection is refused (port 9 would be refused by fetch itself).
  const net = await import('node:net')
  const probe = net.createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  process.env.EVENTS_URL = `http://127.0.0.1:${port}/events`
  process.env.EVENTS_BEARER_TOKEN = 'tst'
  process.env.WORLD_OVERLAY_PORT = '0'
  const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
  const threads = await harness.scanThreads()
  assert.deepEqual(threads, [])
  const compass = _internals.signals().compass
  assert.equal(compass.ok, false)
  assert.ok(compass.downSince)
  assert.equal(compass.lastGoodAt, null)
  assert.ok(!JSON.stringify(compass).includes('tst'), 'the bearer never reaches the record')
})

test('the ledger scan: a 500 fails at once, plainly — it is not the kind that passes', { timeout: 5000 }, async () => {
  let calls = 0
  const ledger = createLedgerClient(cfg, { fetchImpl: async () => (calls++, reply(500, { error: 'internal' })), retryDelayMs: 1 })
  await assert.rejects(ledger.scanSince('2026-10-04T00:00:00Z'), /ledger read 500: internal/)
  assert.equal(calls, 1)
})

test('the ledger scan: a malformed answer is refused, not folded into the world', { timeout: 5000 }, async () => {
  const notJson = { ok: true, status: 200, json: async () => JSON.parse('<html>gateway</html>') }
  await assert.rejects(createLedgerClient(cfg, { fetchImpl: async () => notJson }).scanSince('2026-10-04T00:00:00Z'), SyntaxError)
  for (const body of [{ events: 'x', rows: [] }, { events: [], rows: {} }]) {
    await assert.rejects(createLedgerClient(cfg, { fetchImpl: async () => reply(200, body) }).scanSince('2026-10-04T00:00:00Z'), /not \{ events, rows \}/)
  }
  // null, {} and an error object are not an empty ledger: read as one, every run would vanish and Compass look healthy.
  for (const body of [null, {}, [], { error: 'busy' }, 'x']) {
    await assert.rejects(createLedgerClient(cfg, { fetchImpl: async () => reply(200, body) }).scanSince('2026-10-04T00:00:00Z'), /not \{ events, rows \}/, JSON.stringify(body))
  }
})
