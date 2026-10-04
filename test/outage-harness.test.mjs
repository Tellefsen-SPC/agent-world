// U37 (the Engineering spine's U8) — the harness against a Worker that is slow and half-down: polls that land
// during a scan share it (Compass read once, no stale outage reported after a newer good scan), and a failing
// substrate raises the pill even while the ledger answers. Its own file: the harness reads its config at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)

test('polls during a scan share it, and a failing substrate is an outage even while the ledger answers', { timeout: 10000 }, async () => {
  let scans = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/ledger/scan') {
      scans += 1
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ events: [], rows: [] }))
      }, 200)
      return
    }
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'busy' }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    process.env.EVENTS_URL = `http://127.0.0.1:${server.address().port}/events`
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer'
    process.env.WORLD_OVERLAY_PORT = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    const polls = await Promise.all([harness.scanThreads(), harness.scanThreads(), harness.scanThreads()])
    assert.ok(polls[0] === polls[1] && polls[1] === polls[2], 'every poll gets the one scan\'s answer')
    assert.equal(scans, 1, 'three polls, one scan of the ledger')
    const compass = _internals.signals().compass
    assert.equal(compass.ok, false)
    assert.match(compass.error, /substrate read 503: busy/)
    assert.ok(!JSON.stringify(compass).includes('zztest-bearer'))
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})
