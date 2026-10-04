// Agent World — U7, the realtime nudge, over the Compass Worker's GET /events/stream (server-sent events of the ledger).
// Local SSE servers on 127.0.0.1 stand in for the Worker, speaking its contract (tellefsen-compass-mcp
// src/lib/approval/stream.ts on main): bearer, `retry:`, comments, `id: <at>|<id>` · `event: ledger` · `data: {…}`,
// keepalives, a close after its lifetime, and a resume from Last-Event-ID. No Compass, no network beyond loopback.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { createParser, createStream } = await import(path.join(root, 'server/harnesses/compass/stream.mjs'))
const { loadConfig } = await import(path.join(root, 'server/harnesses/compass/config.mjs'))

const BEARER = 'zztest-stream-bearer'
const ID_A = '2026-10-04T08:00:00.123456+00:00|00000000-0000-4000-8000-00000000000a'
const ID_B = '2026-10-04T08:00:02.000000+00:00|00000000-0000-4000-8000-00000000000b'
const row = (id, event_type = 'gate_waiting') => ({ id, run_id: 'zztest-run-' + id.slice(-1), event_type, skill: 'zztest-approver', client: 'ZZTEST Client', at: '2026-10-04T08:00:00Z', parent_run_id: null, payload: {} })
const frame = (id, data, event = 'ledger') => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 3000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await sleep(5)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A local stand-in for the Worker's stream: `handler(req, res, n)` gets the request number; every request is kept. */
async function worker(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ at: Date.now(), headers: req.headers, url: req.url, method: req.method })
    handler(req, res, requests.length)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/events/stream`
  return {
    url,
    requests,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    },
  }
}
const open = (res) => res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' })
/** Fast timings for tests; the defaults are the production ones (STREAM_DEFAULTS). */
const fast = { baseMs: 20, maxMs: 400, minRetryMs: 5, idleMs: 2000, minLifeMs: 0, connectMs: 1000 }
function client(url, extra = {}, cfgExtra = {}) {
  const events = []
  const warns = []
  const logs = []
  const s = createStream({ streamUrl: url, eventsBearerToken: BEARER, streamEnabled: true, readTimeoutMs: 1000, ...cfgExtra }, { onEvent: (r) => events.push(r), warn: (m) => warns.push(m), log: (m) => logs.push(m), ...fast, ...extra })
  return { s, events, warns, logs }
}

test('the parser reads the Worker\'s frames however the bytes are split, with LF, CRLF or CR line ends', () => {
  const text = `retry: 1000\n: connected — polling every 2s\n\n${frame(ID_A, row('a'))}: keepalive\n\nid: ${ID_B}\n\ndata: line one\ndata:line two\n\n`
  for (const eol of ['\n', '\r\n', '\r']) {
    const body = text.replace(/\n/g, eol)
    for (const step of [1, 2, 7, body.length]) {
      const got = []
      const comments = []
      let retry = null
      const p = createParser({ onMessage: (m) => got.push(m), onComment: (c) => comments.push(c), onRetry: (ms) => (retry = ms) })
      for (let i = 0; i < body.length; i += step) p.feed(body.slice(i, i + step))
      p.end() // a CR-only stream holds its last CR until it knows no LF follows
      assert.equal(retry, 1000, `retry · ${JSON.stringify(eol)} · step ${step}`)
      assert.deepEqual(comments, ['connected — polling every 2s', 'keepalive'])
      assert.equal(got.length, 2, 'the ledger event, then the plain message (an id with no data dispatches nothing)')
      assert.deepEqual(got[0], { event: 'ledger', data: JSON.stringify(row('a')), id: ID_A })
      assert.deepEqual(got[1], { event: 'message', data: 'line one\nline two', id: ID_B }, 'the id persists, multi-line data joins with LF')
      assert.equal(p.lastEventId(), ID_B)
    }
  }
  const p = createParser()
  p.feed(`id: bad\0id\n\n`)
  assert.equal(p.lastEventId(), '', 'an id with a NUL is ignored')
  assert.throws(() => createParser({ maxBytes: 64 }).feed(`data: ${'x'.repeat(100)}\n`), /ran past 64 bytes/)
  assert.throws(() => createParser({ maxBytes: 64 }).feed('x'.repeat(100)), /ran past 64 bytes/, 'a line with no end is bounded too')
})

test('subscribes with the bearer, hands each ledger event on, and resumes from Last-Event-ID when the Worker closes the stream', { timeout: 10000 }, async () => {
  const w = await worker((req, res, n) => {
    open(res)
    if (n === 1) {
      res.write('retry: 30\n: connected — polling every 2s\n\n')
      res.write(frame(ID_A, row('a')))
      res.write(`event: error\ndata: {"error":"zztest"}\n\n`) // the Worker's own read failed: logged, not an event
      res.end() // the Worker's ~50 s lifetime, shortened
    } else {
      res.write(': connected\n\n')
      res.write(frame(ID_B, row('b', 'gate_passed')))
    }
  })
  const c = client(w.url)
  try {
    assert.equal(c.s.start(), true)
    await until(() => c.events.length === 2, 3000, 'two events')
    assert.deepEqual(c.events.map((e) => e.id), ['a', 'b'])
    assert.equal(c.events[1].event_type, 'gate_passed')
    const [first, second] = w.requests
    assert.equal(first.method, 'GET')
    assert.equal(first.url, '/events/stream', 'no filter, no since: the stream starts at now')
    assert.equal(first.headers.authorization, `Bearer ${BEARER}`)
    assert.match(first.headers.accept, /text\/event-stream/)
    assert.equal(first.headers['last-event-id'], undefined, 'nothing to resume on the first connect')
    assert.equal(second.headers['last-event-id'], ID_A, 'the reconnect resumes exactly where the stream left off')
    assert.ok(second.at - first.at >= 25, 'the Worker\'s retry hint (30 ms) is honoured')
    assert.deepEqual(c.warns, ['bot-crossing: compass — realtime: subscribed ops_run_events (GET /events/stream)'], 'subscribed is said once; a routine reconnect is not a warning')
    assert.ok(c.logs.some((l) => /the Worker reported \{"error":"zztest"\}/.test(l)))
    const st = c.s.status()
    assert.equal(st.state, 'open')
    assert.equal(st.events, 2)
    assert.equal(st.failures, 0)
    assert.ok(!JSON.stringify(st).includes(BEARER) && !c.logs.join('\n').includes(BEARER), 'the bearer is in the header only')
  } finally {
    c.s.stop()
    await w.close()
  }
})

test('a failing stream backs off — longer each time, capped — says so once, and says when it is back', { timeout: 10000 }, async () => {
  const w = await worker((req, res, n) => {
    if (n <= 4) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      return res.end('{"error":"busy"}')
    }
    open(res)
    res.write(': connected\n\n')
  })
  const c = client(w.url, { baseMs: 20, maxMs: 70 })
  try {
    c.s.start()
    await until(() => c.warns.length === 2, 5000, 'the stream to come back and hold')
    assert.equal(c.s.status().state, 'open')
    const gaps = w.requests.slice(1).map((r, i) => r.at - w.requests[i].at)
    assert.equal(gaps.length, 4)
    assert.ok(gaps[0] >= 15 && gaps[1] >= 35, `doubling: ${gaps}`)
    assert.ok(gaps[2] >= 60 && gaps[3] >= 60 && gaps[3] < 300, `capped at maxMs: ${gaps}`)
    assert.equal(c.warns.length, 2, `one warning for the outage, one for the recovery: ${c.warns.join(' | ')}`)
    assert.match(c.warns[0], /realtime: stream unavailable — GET \/events\/stream answered 503\. The polls carry on/)
    assert.equal(c.warns[1], 'bot-crossing: compass — realtime: subscribed ops_run_events (GET /events/stream) — back after 4 failed tries')
    assert.equal(c.s.status().failures, 0, 'reset once it is open')
  } finally {
    c.s.stop()
    await w.close()
  }
})

test('a refused bearer, or a Worker without the route, waits the longest backoff at once and names why', { timeout: 10000 }, async () => {
  for (const [status, why] of [[401, /refused the events bearer \(401\)/], [404, /has no GET \/events\/stream \(404\) — not deployed yet\?/]]) {
    const w = await worker((req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end('{"error":"x"}')
    })
    const c = client(w.url, { maxMs: 5000 })
    try {
      c.s.start()
      await until(() => c.s.status().state === 'waiting', 2000, `a ${status}`)
      const st = c.s.status()
      assert.equal(st.retryInMs, 5000, `${status}: straight to the longest wait`)
      assert.match(st.error, why)
      assert.match(c.warns[0], why)
      await sleep(100)
      assert.equal(w.requests.length, 1, `${status}: no hammering`)
    } finally {
      c.s.stop()
      await w.close()
    }
  }
})

test('a Worker that never answers, answers in the wrong type, goes quiet, or sends a giant message is given up on and retried', { timeout: 10000 }, async () => {
  // never answers: a socket that accepts and says nothing
  const sockets = []
  const hang = net.createServer((s) => sockets.push(s))
  await new Promise((r) => hang.listen(0, '127.0.0.1', r))
  const c1 = client(`http://127.0.0.1:${hang.address().port}/events/stream`, { connectMs: 60 })
  try {
    c1.s.start()
    await until(() => /did not answer within 60 ms/.test(c1.s.status().error), 2000, 'the connect deadline')
  } finally {
    c1.s.stop()
    for (const s of sockets) s.destroy()
    await new Promise((r) => hang.close(r))
  }

  const cases = [
    ['wrong type', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>login</html>') }, /did not answer with text\/event-stream/, {}],
    ['quiet', (req, res) => { open(res); res.write(': connected\n\n') }, /went quiet for 80 ms/, { idleMs: 80, minLifeMs: 1000 }],
    ['giant', (req, res) => { open(res); res.write(`data: ${'x'.repeat(5000)}`) }, /ran past 1024 bytes/, { maxMessageBytes: 1024, minLifeMs: 1000 }],
    ['empty close', (req, res) => { open(res); res.end() }, /closed after \d+ ms with nothing sent/, { minLifeMs: 5000 }],
  ]
  for (const [name, handler, why, opts] of cases) {
    const w = await worker(handler)
    const c = client(w.url, opts)
    try {
      c.s.start()
      await until(() => w.requests.length >= 3, 3000, `${name}: two retries`)
      const gaps = w.requests.slice(1).map((r, i) => r.at - w.requests[i].at)
      assert.ok(gaps[1] > gaps[0], `${name}: a Worker that opens and then fails keeps backing off: ${gaps}`)
      assert.ok(c.warns.some((m) => why.test(m)), `${name}: ${c.warns.join(' | ')}`)
      assert.equal(c.warns.filter((m) => /unavailable/.test(m)).length, 1, `${name}: the outage is said once`)
    } finally {
      c.s.stop()
      await w.close()
    }
  }
})

test('the off switch: WORLD_STREAM=0 makes no connection at all; the URL is derived from EVENTS_URL only when it ends in /events', { timeout: 5000 }, async () => {
  assert.equal(loadConfig({ EVENTS_URL: 'https://w.example/events' }).streamUrl, 'https://w.example/events/stream')
  assert.equal(loadConfig({ EVENTS_URL: 'https://w.example/events/' }).streamUrl, 'https://w.example/events/stream')
  assert.equal(loadConfig({ EVENTS_URL: 'https://w.example/somewhere' }).streamUrl, '', 'never a GET on an unknown route')
  assert.equal(loadConfig({}).streamEnabled, true, 'on by default')
  for (const v of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) assert.equal(loadConfig({ WORLD_STREAM: v }).streamEnabled, false, v)
  for (const v of ['1', 'on', '']) assert.equal(loadConfig({ WORLD_STREAM: v }).streamEnabled, true, v)

  const w = await worker((req, res) => open(res))
  const c = client(w.url, {}, { streamEnabled: loadConfig({ WORLD_STREAM: '0' }).streamEnabled })
  try {
    assert.equal(c.s.start(), false)
    await sleep(80)
    assert.equal(w.requests.length, 0, 'switched off: no request')
    assert.equal(c.s.status().state, 'off')
    assert.match(c.s.status().error, /WORLD_STREAM=0/)
    const noToken = createStream({ streamUrl: w.url, eventsBearerToken: '', streamEnabled: true })
    assert.equal(noToken.start(), false, 'no bearer: nothing to subscribe with')
  } finally {
    c.s.stop()
    await w.close()
  }
})

test('stop() ends the stream and nothing reconnects; a resume id too long to be one is not sent', { timeout: 5000 }, async () => {
  const long = '2026-10-04T08:00:00Z|' + 'x'.repeat(400)
  const w = await worker((req, res, n) => {
    open(res)
    if (n === 1) {
      res.write(frame(long, row('c')))
      res.end()
    }
  })
  const c = client(w.url)
  try {
    c.s.start()
    await until(() => w.requests.length === 2, 2000, 'the reconnect')
    assert.equal(w.requests[1].headers['last-event-id'], undefined, 'a 400-character id is not a resume point')
    c.s.stop()
    await sleep(100)
    assert.equal(w.requests.length, 2, 'stopped: no further connection')
    assert.equal(c.s.status().state, 'off')
  } finally {
    c.s.stop()
    await w.close()
  }
})
