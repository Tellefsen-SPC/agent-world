// Agent World — U16W wiring (adapter side; ES-4.6; docs/adr/0008): the browser asks the sidecar's POST /ask, the
// sidecar forwards to the Worker's POST /ask with the bearer. A stand-in Worker on loopback answers here — never the
// real Compass, never a model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { createAsk, parseQuestion, retryAfterOf, MAX_QUESTION_CHARS } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
const cfgModule = await import(path.join(root, 'server/harnesses/compass/config.mjs'))
const { loadConfig } = cfgModule
const { createOverlayApi, startOverlayApi, mayAsk, isPageOrigin } = await import(path.join(root, 'server/harnesses/compass/overlay-api.mjs'))
const { makeViewer, PRESETS } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))
const { validate } = await import('./lib/validate.mjs')
const schema = JSON.parse(fs.readFileSync(path.join(root, 'spec/ask.v1.json'), 'utf8'))
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/ask.synthetic.json'), 'utf8'))

const ALPHA = 'a1a1a1a1-0000-4000-8000-000000000001'
const QUESTION = 'ZZTEST-QUESTION-7f3a: what is this run waiting on?'
const SECRET_ANSWER = cases.answer.body.answer
const origin = 'http://127.0.0.1:5274'

/** A stand-in for the Worker's POST /ask: records what reached it, answers what the test says. */
async function standIn(reply = () => ({ status: 200, body: cases.answer.body })) {
  const seen = []
  const server = http.createServer((req, res) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', async () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, type: req.headers['content-type'], body: s ? JSON.parse(s) : null })
      const r = await reply(seen.at(-1))
      if (r.hang) return // never answers
      const headers = { 'Content-Type': r.raw ? 'text/html' : 'application/json', ...(r.headers || {}) }
      res.writeHead(r.status, headers)
      res.end(r.raw ?? JSON.stringify(r.body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return { seen, url, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

const cfgFor = (workerUrl, env = {}) => loadConfig({ EVENTS_URL: `${workerUrl}/events`, EVENTS_BEARER_TOKEN: 'zztest-events-bearer', ...env })

test('U16W: config derives the /ask URL from EVENTS_URL like the reads, prefers WORLD_ASK_BEARER, and waits longer than the Worker\'s 25 s model deadline', () => {
  const cfg = loadConfig({ EVENTS_URL: 'https://w.example/events', EVENTS_BEARER_TOKEN: 'ev' })
  assert.equal(cfg.askUrl, 'https://w.example/ask')
  assert.equal(cfg.askBearerToken, 'ev', 'the events bearer stands in without WORLD_ASK_BEARER')
  assert.equal(loadConfig({ EVENTS_URL: 'https://w.example/events', EVENTS_BEARER_TOKEN: 'ev', WORLD_ASK_BEARER: ' ask ' }).askBearerToken, 'ask')
  assert.ok(cfg.askTimeoutMs > 28_000, 'the Worker\'s own 28 s after the start runs out before this side gives up')
  assert.equal(cfg.askTimeoutMs, 50_000)
  assert.equal(loadConfig({ EVENTS_URL: 'https://w.example/hooks', EVENTS_BEARER_TOKEN: 'ev' }).askUrl, '', 'no /events tail, no /ask URL')
  assert.equal(loadConfig({}).askUrl, '')
})

test('U16W: the body is checked as the Worker checks it — the question, its bounds, the six context keys, a uuid run_id, places without quotes; zone is sent as town', () => {
  const ok = parseQuestion({ question: '  what is waiting?\n\tthanks  ', context: { run_id: ALPHA.toUpperCase(), zone: 'ZZTEST Client', milestone: 'ZZTEST milestone', project: 'ZZTEST project' } })
  assert.deepEqual(ok, { question: 'what is waiting?\n\tthanks', context: { run_id: ALPHA, town: 'ZZTEST Client', milestone: 'ZZTEST milestone', project: 'ZZTEST project' } })
  assert.deepEqual(parseQuestion({ question: 'q' }), { question: 'q', context: {} })
  for (const [body, why] of [
    [{}, /question is required/],
    [null, /question is required/],
    [[], /question is required/],
    [{ question: '   ' }, /question is required/],
    [{ question: 'x'.repeat(MAX_QUESTION_CHARS + 1) }, /exceeds 1000/],
    [{ question: 'bell\u0007' }, /control characters/],
    [{ question: 'q', actor: 'someone' }, /unknown field "actor"/],
    [{ question: 'q', context: { actor: 'someone' } }, /unknown context field "actor"/],
    [{ question: 'q', context: { person: 'someone' } }, /unknown context field "person"/],
    [{ question: 'q', context: 'ZZTEST Client' }, /context must be an object/],
    [{ question: 'q', context: { run_id: 'not-a-uuid' } }, /run_id must be a uuid/],
    [{ question: 'q', context: { town: 'ZZTEST "Client"' } }, /quotes/],
    [{ question: 'q', context: { client: 'a\\b' } }, /quotes, backslashes/],
    [{ question: 'q', context: { town: 'x'.repeat(201) } }, /exceeds 200/],
    [{ question: 'q', context: { town: 'ZZTEST Client', zone: 'ZZTEST Client 2' } }, /disagree/],
    [{ question: 'q', context: { project: 7 } }, /must be a string/],
  ]) assert.match(parseQuestion(body).error || '', why, JSON.stringify(body)?.slice(0, 60))
  assert.equal(parseQuestion({ question: 'x'.repeat(MAX_QUESTION_CHARS) }).error, undefined, '1000 characters is allowed')
})

test('U16W: Retry-After reads as whole seconds, from a number or an HTTP date', () => {
  assert.equal(retryAfterOf('15120'), 15120)
  assert.equal(retryAfterOf(new Date(1_000_000 + 90_500).toUTCString(), 1_000_000), 90)
  assert.equal(retryAfterOf('soon'), null)
  assert.equal(retryAfterOf(undefined), null)
})

test('U16W: the forwarder POSTs {question, context} to the Worker\'s /ask with the bearer, and passes the answer back cut to spec/ask.v1.json', async () => {
  const worker = await standIn(() => ({ status: 200, body: { ...cases.answer.body, actor: 'someone', debug: { prompt: 'never forwarded' } } })) // keys the contract does not name
  try {
    const out = await createAsk(cfgFor(worker.url)).ask({ question: QUESTION, context: { run_id: ALPHA, zone: 'ZZTEST Client' } })
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, cases.answer.body, 'the stray keys stay on the Worker')
    assert.deepEqual(validate(schema, out.body), [])
    assert.equal(worker.seen.length, 1)
    const got = worker.seen[0]
    assert.equal(got.method, 'POST')
    assert.equal(got.url, '/ask')
    assert.equal(got.authorization, 'Bearer zztest-events-bearer')
    assert.match(got.type, /^application\/json/)
    assert.deepEqual(got.body, { question: QUESTION, context: { run_id: ALPHA, town: 'ZZTEST Client' } })
  } finally {
    await worker.close()
  }
  // WORLD_ASK_BEARER, when set, is the bearer that goes
  const second = await standIn()
  try {
    await createAsk(cfgFor(second.url, { WORLD_ASK_BEARER: 'zztest-ask-bearer' })).ask({ question: 'q' })
    assert.equal(second.seen[0].authorization, 'Bearer zztest-ask-bearer')
  } finally {
    await second.close()
  }
})

test('U16W: the Worker\'s errors come back with its status and a contract body — 429 with its wait, 503 off, 502 provider and substrate failures, 401, 404, an HTML error page', async () => {
  const replies = {
    budget: { status: 429, body: cases.budget.body, headers: { 'Retry-After': '15120' } },
    off: { status: 503, body: cases.not_configured.body },
    provider: { status: 502, body: cases.provider_failed.body },
    timeout: { status: 502, body: cases.provider_timeout.body },
    substrate: { status: 502, body: cases.substrate_unavailable.body },
    ledger: { status: 502, body: cases.ledger_unavailable.body },
    unauth: { status: 401, body: cases.unauthorized.body },
    missing: { status: 404, body: { error: 'not found' } },
    html: { status: 520, raw: '<html>cloudflare</html>' },
    empty200: { status: 200, body: { based_on: [] } },
  }
  let next = 'budget'
  const worker = await standIn(() => replies[next])
  const ask = createAsk(cfgFor(worker.url))
  try {
    const run = async (name) => ((next = name), ask.ask({ question: QUESTION }))
    const b = await run('budget')
    assert.equal(b.status, 429)
    assert.equal(b.body.error, 'ask_budget_exceeded')
    assert.equal(b.body.retry_after, 15120)
    assert.equal(b.headers['Retry-After'], '15120')
    assert.equal(b.body.limit, 200)
    assert.deepEqual(await run('off').then((r) => [r.status, r.body.error, r.body.detail]), [503, 'ask_not_configured', 'ASK_PROVIDER is not set on the Worker'])
    const p = await run('provider')
    assert.deepEqual([p.status, p.body.error, p.body.run_id, p.body.provider], [502, 'provider_failed', cases.provider_failed.body.run_id, 'anthropic'])
    assert.ok(!('ledger' in p.body), 'cut to the contract')
    assert.deepEqual(await run('timeout').then((r) => [r.status, r.body.error]), [502, 'provider_timeout'])
    assert.deepEqual(await run('substrate').then((r) => [r.status, r.body.error]), [502, 'substrate_unavailable'])
    assert.deepEqual(await run('ledger').then((r) => [r.status, r.body.error]), [502, 'ledger_unavailable'])
    assert.deepEqual(await run('unauth').then((r) => [r.status, r.body]), [401, { error: 'unauthorized' }])
    assert.deepEqual(await run('missing').then((r) => [r.status, r.body.error]), [404, 'not found'])
    assert.deepEqual(await run('html').then((r) => [r.status, r.body]), [520, { error: 'http_520' }])
    assert.deepEqual(await run('empty200').then((r) => [r.status, r.body.error]), [502, 'bad_answer'], 'a 200 that is not an answer is not shown as one')
    for (const r of Object.keys(replies)) if (r !== 'empty200') assert.deepEqual(validate(schema.$defs.error, (await run(r)).body), [], r)
  } finally {
    await worker.close()
  }
})

test('U16W: the sidecar\'s own answers — a bad body is never sent, nothing configured is 503, a hanging Worker is 504 at the deadline, a dead one 502, and one question at a time', async () => {
  const worker = await standIn(() => ({ hang: true }))
  try {
    const cfg = { ...cfgFor(worker.url), askTimeoutMs: 150 }
    const ask = createAsk(cfg)
    assert.deepEqual(await ask.ask({}).then((r) => [r.status, /question is required/.test(r.body.error)]), [400, true])
    assert.equal(worker.seen.length, 0, 'a body the Worker would refuse never leaves the machine')
    // the slot is taken before the first await, so the second ask needs no wait to find it taken
    const first = ask.ask({ question: 'q1' })
    assert.deepEqual(await ask.ask({ question: 'q2' }).then((r) => [r.status, r.body.error]), [409, 'ask_in_flight'])
    const slow = await first
    assert.deepEqual([slow.status, slow.body.error], [504, 'worker_timeout'])
    assert.match(slow.body.detail, /did not answer within/)
    assert.equal(ask.inFlight(), false, 'the slot is free again after the deadline')
    // whether q1 reached the stand-in inside 150 ms depends on the machine's load; that q2 never did does not
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(!worker.seen.some((s) => s.body?.question === 'q2'), 'the refused second question never reached the Worker')
    assert.ok(worker.seen.length <= 1)
  } finally {
    await worker.close()
  }
  for (const env of [{ EVENTS_URL: '' }, { EVENTS_BEARER_TOKEN: '' }, { EVENTS_URL: 'http://127.0.0.1:9/hooks' }]) {
    let called = 0
    const ask = createAsk(loadConfig({ EVENTS_URL: 'http://127.0.0.1:9/events', EVENTS_BEARER_TOKEN: 'b', ...env }), { fetchImpl: async () => (called++, { ok: true, status: 200, json: async () => ({}) }) })
    assert.deepEqual(await ask.ask({ question: 'q' }).then((r) => [r.status, r.body.error]), [503, 'world_not_configured'], JSON.stringify(env))
    assert.equal(called, 0)
  }
  const dead = createAsk(loadConfig({ EVENTS_URL: 'http://127.0.0.1:9/events', EVENTS_BEARER_TOKEN: 'b' }), { fetchImpl: async () => { throw new TypeError('fetch failed') } })
  assert.deepEqual(await dead.ask({ question: 'q' }).then((r) => [r.status, r.body.error]), [502, 'worker_unreachable'])
})

test('U16W (review 7): a Worker that echoes the bearer back — in an answer or an error — never gets it as far as the page', async () => {
  let echo = 'answer'
  const worker = await standIn((seen) => {
    const bearer = String(seen.authorization || '').replace(/^Bearer /, '')
    return echo === 'answer'
      ? { status: 200, body: { ...cases.answer.body, answer: `ok — the request carried ${bearer}` } }
      : { status: 502, body: { error: 'provider_failed', detail: `the vendor quoted: Bearer ${bearer}` } }
  })
  try {
    const ask = createAsk(cfgFor(worker.url))
    const a = await ask.ask({ question: 'q' })
    assert.equal(a.body.answer, 'ok — the request carried [redacted]')
    echo = 'error'
    const e = await ask.ask({ question: 'q' })
    assert.equal(e.body.detail, 'the vendor quoted: Bearer [redacted]')
    for (const r of [a, e]) assert.ok(!JSON.stringify(r).includes('zztest-events-bearer'), 'no bearer in what the sidecar passes on')
  } finally {
    await worker.close()
  }
})

/** The sidecar in front of a forwarder that points at a stand-in Worker. */
async function sidecarWith(worker, viewerFor, logs, { pagePort } = {}) {
  const ask = createAsk(cfgFor(worker.url), { log: (line) => logs?.push(String(line)) })
  const world = { planets: [{ key: 'zz', home: true }], towns: [], campus: { name: 'ZZTEST HQ' } }
  const api = await startOverlayApi(createOverlayApi({ getWorld: async () => world, descriptor: async () => world, ask, viewerFor, ...(pagePort ? { pagePort } : {}), log: (...a) => logs?.push(a.join(' ')) }), { port: 0 })
  return { api, base: `http://127.0.0.1:${api.port}` }
}
const post = (base, body, headers = {}) =>
  fetch(`${base}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('U16W: the sidecar\'s POST /ask — Owner with a local Origin gets the Worker\'s answer; the browser never sees the bearer; the question and the answer are never logged', async () => {
  const worker = await standIn()
  const logs = []
  const consoleLines = []
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const k of Object.keys(saved)) console[k] = (...a) => consoleLines.push(a.map(String).join(' '))
  const s = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }), logs)
  try {
    const res = await post(s.base, { question: QUESTION, context: { run_id: ALPHA, town: 'ZZTEST Client' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), origin)
    const text = await res.text()
    assert.deepEqual(JSON.parse(text), cases.answer.body)
    assert.ok(!/zztest-events-bearer|authorization|bearer/i.test(text + JSON.stringify([...res.headers])), 'no bearer reaches the page')
    assert.equal(worker.seen[0].authorization, 'Bearer zztest-events-bearer', 'the bearer is the sidecar\'s to send')
    // the preflight a page makes before a JSON POST
    const pre = await fetch(`${s.base}/ask`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/)
    const everything = [...logs, ...consoleLines].join('\n')
    assert.ok(logs.some((l) => /^ask: 200 answered/.test(l)), 'the ask is logged by its status')
    assert.ok(!everything.includes('ZZTEST-QUESTION-7f3a'), 'the question is never logged')
    assert.ok(!everything.includes(SECRET_ANSWER.slice(0, 40)), 'the answer is never logged')
  } finally {
    Object.assign(console, saved)
    await s.api.close()
    await worker.close()
  }
})

test('U16W: the sidecar\'s POST /ask refuses before the Worker is asked — no Origin, a foreign Origin, every preset but Owner, no viewer, GET, a body that is not JSON, over 8 KB', async () => {
  const worker = await standIn()
  try {
    const owner = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }))
    try {
      assert.equal((await post(owner.base, { question: 'q' }, { Origin: '' })).status, 403, 'no Origin')
      assert.equal((await post(owner.base, { question: 'q' }, { Origin: 'https://evil.example' })).status, 403, 'a foreign Origin')
      const get = await fetch(`${owner.base}/ask`)
      assert.deepEqual([get.status, get.headers.get('allow')], [405, 'POST'])
      assert.equal((await post(owner.base, { question: 'q' }, { 'Content-Type': 'text/plain' })).status, 415, 'a simple (non-preflighted) POST is refused')
      assert.deepEqual(await post(owner.base, '{"question":').then(async (r) => [r.status, (await r.json()).error]), [400, 'body must be JSON: {"question": "…", "context": {…}}'])
      assert.equal((await post(owner.base, { question: 'q', context: { town: 'x'.repeat(9000) } })).status, 413, 'over 8 KB')
      assert.deepEqual(await post(owner.base, {}).then(async (r) => [r.status, /question is required/.test((await r.json()).error)]), [400, true], 'an empty body is the sidecar\'s 400 — it does not reach the Worker')
      assert.equal(worker.seen.length, 0, 'none of these reached the Worker')
    } finally {
      await owner.api.close()
    }
    for (const preset of Object.keys(PRESETS).filter((p) => p !== 'owner')) {
      const other = await sidecarWith(worker, () => makeViewer({ preset }))
      try {
        const res = await post(other.base, { question: QUESTION })
        assert.equal(res.status, 403, preset)
        assert.deepEqual(await res.json(), { error: 'The PA answers the Owner only' })
      } finally {
        await other.api.close()
      }
    }
    for (const viewerFor of [() => null, () => ({ preset: 'owner' }), () => { throw new Error('no identity') }]) {
      const s = await sidecarWith(worker, viewerFor)
      try {
        assert.equal((await post(s.base, { question: QUESTION })).status, 403, 'fails closed — a preset name alone is not the capability')
      } finally {
        await s.api.close()
      }
    }
    assert.equal(worker.seen.length, 0, 'a refused viewer never causes a Worker call')
  } finally {
    await worker.close()
  }
})

test('U16W: the sidecar passes the budget\'s 429 through with Retry-After and the wait in the body', async () => {
  const worker = await standIn(() => ({ status: 429, body: cases.budget.body, headers: { 'Retry-After': '15120' } }))
  const s = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }))
  try {
    const res = await post(s.base, { question: QUESTION })
    assert.equal(res.status, 429)
    assert.equal(res.headers.get('retry-after'), '15120')
    const body = await res.json()
    assert.equal(body.retry_after, 15120)
    assert.deepEqual(validate(schema.$defs.error, body), [])
  } finally {
    await s.api.close()
    await worker.close()
  }
})

test('U16W: only the Owner preset holds `ask`; mayAsk reads the capability, never the preset\'s name', () => {
  const holders = Object.entries(PRESETS).filter(([, p]) => p.capabilities.includes('ask')).map(([name]) => name)
  assert.deepEqual(holders, ['owner'])
  assert.equal(mayAsk(makeViewer({ preset: 'owner' })), true)
  assert.equal(mayAsk({ preset: 'owner' }), false)
  assert.equal(mayAsk({ capabilities: ['view', 'ask'] }), true)
  assert.equal(mayAsk(null), false)
  assert.ok(!/\bactor\b/i.test(fs.readFileSync(path.join(root, 'spec/ask.v1.json'), 'utf8')), 'the contract names no person-shaped field')
  // ask.mjs reads actor values in one place only — the named-person backstop (review 5) — and sends none anywhere
  const code = fs.readFileSync(path.join(root, 'server/harnesses/compass/ask.mjs'), 'utf8')
  const start = code.indexOf('// ─── The backstop')
  const end = code.indexOf('// ─── The forwarder')
  assert.ok(start > 0 && end > start)
  assert.ok(!/\bactors?\b/i.test(code.slice(0, start) + code.slice(end)), 'actor appears only inside the backstop section')
})

test('U16W (review 8): the side port waits 50 s by default and never more than 55 s — under the page\'s 60 s, so the page hears its 504', () => {
  const { ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS } = cfgModule
  assert.deepEqual([ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS], [50_000, 55_000])
  assert.equal(loadConfig({ WORLD_ASK_TIMEOUT_MS: '20000' }).askTimeoutMs, 20_000)
  for (const big of ['55001', '60000', '600000', '1e9']) assert.equal(loadConfig({ WORLD_ASK_TIMEOUT_MS: big }).askTimeoutMs, 55_000, big)
  for (const bad of ['', 'abc', '-5', '0']) assert.equal(loadConfig({ WORLD_ASK_TIMEOUT_MS: bad }).askTimeoutMs, 50_000, `"${bad}" is the default`)
  const page = Number(fs.readFileSync(path.join(root, 'overlay/zones.mjs'), 'utf8').match(/ASK_PAGE_TIMEOUT_MS = ([\d_]+)/)[1].replace(/_/g, ''))
  assert.equal(page, 60_000)
  assert.ok(MAX_ASK_TIMEOUT_MS < page, 'the cap stays below the page\'s own wait')
})

test('U16W (review 6): the PA answers the world\'s own page only — a loopback host AND the page\'s port; any other local page is refused, preflight included', async () => {
  assert.equal(isPageOrigin('http://127.0.0.1:5274', 5274), true)
  assert.equal(isPageOrigin('http://localhost:5274', 5274), true)
  assert.equal(isPageOrigin('http://[::1]:5274', 5274), true)
  for (const o of ['http://127.0.0.1:5275', 'http://localhost:3000', 'https://127.0.0.1:5274', 'http://127.0.0.2:5274', 'http://example.com:5274', 'http://127.0.0.1', 'null', '', undefined]) {
    assert.equal(isPageOrigin(o, 5274), false, String(o))
  }
  const worker = await standIn()
  try {
    // one sidecar at a time: startOverlayApi closes the one before it (the Vite re-import guard)
    const s = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }))
    try {
      const other = await post(s.base, { question: QUESTION }, { Origin: 'http://127.0.0.1:5999' })
      assert.equal(other.status, 403)
      assert.match((await other.json()).error, /the world's own page only \(http:\/\/127\.0\.0\.1:5274\)/)
      const pre = await fetch(`${s.base}/ask`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' } })
      assert.equal(pre.status, 403, 'another local page gets no preflight for /ask')
      assert.equal((await fetch(`${s.base}/ask`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5274', 'Access-Control-Request-Method': 'POST' } })).status, 204)
      assert.equal((await fetch(`${s.base}/world`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000' } })).status, 204, 'the other routes keep their rule')
    } finally {
      await s.api.close()
    }
    const moved = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }), null, { pagePort: 5294 })
    try {
      assert.equal((await post(moved.base, { question: QUESTION }, { Origin: 'http://127.0.0.1:5274' })).status, 403, 'PORT moves the page, and the rule with it')
      assert.equal((await post(moved.base, { question: QUESTION }, { Origin: 'http://127.0.0.1:5294' })).status, 200)
    } finally {
      await moved.api.close()
    }
    assert.equal(worker.seen.length, 1, 'only the world\'s own page reached the Worker')
  } finally {
    await worker.close()
  }
  assert.equal(loadConfig({ PORT: '5294' }).pagePort, 5294)
  for (const bad of ['', 'x', '0', '70000']) assert.equal(loadConfig({ PORT: bad }).pagePort, 5274, `"${bad}"`)
})

test('U16W (review 9): a body over 8 KB gets its 413 before the connection closes — sent chunked with no length, all at once, or still being sent', async () => {
  const worker = await standIn()
  const s = await sidecarWith(worker, () => makeViewer({ preset: 'owner' }))
  const port = s.api.port
  /** POST /ask chunked: `chunks` of 1 KB, then end — or keep writing slowly and never end. */
  const chunked = (chunks, { endless = false } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ask', method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'Transfer-Encoding': 'chunked' } }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body: JSON.parse(text || '{}'), closed: new Promise((r) => (req.socket.destroyed ? r() : req.socket.once('close', r))) }))
      })
      req.on('error', (err) => resolve({ error: err.code || err.message }))
      req.write('{"question":"')
      for (let i = 0; i < chunks; i++) req.write('x'.repeat(1024))
      if (!endless) return req.end('"}')
      const timer = setInterval(() => (req.destroyed ? clearInterval(timer) : req.write('x'.repeat(256))), 50)
      timer.unref()
    })
  try {
    const ended = await chunked(10)
    assert.deepEqual([ended.error, ended.status, ended.body.error, ended.connection], [undefined, 413, 'body exceeds 8192 bytes', 'close'])
    const flowing = await chunked(9, { endless: true })
    assert.deepEqual([flowing.error, flowing.status], [undefined, 413], 'the answer arrives while the body is still coming')
    const t0 = Date.now()
    await flowing.closed
    assert.ok(Date.now() - t0 < 3000, 'and the connection is closed after it')
    const sized = await post(s.base, `{"question":"${'y'.repeat(9000)}"}`)
    assert.equal(sized.status, 413, 'with a Content-Length too')
    assert.equal(worker.seen.length, 0, 'none of them reached the Worker')
  } finally {
    await s.api.close()
    await worker.close()
  }
})

test('U16 (review 5): the backstop\'s names — machine actors, skills and their steps, and places are never people; the rest are, longest first', async () => {
  const { personNames, MACHINE_ACTORS } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
  const names = personNames(['zztest', 'world', 'Worker', 'claude_code', 'cowork', 'zztest-approver', 'zztest-approver:propose', 'ZZTEST Client', '  Ann Zztest  ', 'ann zztest', 'Bo', 'x', '42', 'a.b@zztest.example'], { skills: ['zztest-approver'], places: ['ZZTEST Client'] })
  assert.deepEqual(names, ['a.b@zztest.example', 'Ann Zztest', 'Bo'])
  for (const m of ['world', 'worker', 'claude_code', 'cowork', 'zztest']) assert.ok(MACHINE_ACTORS.includes(m), m)
})

test('U16 (review 5): an exact word or phrase only — a name inside another word, a lower-case single name, or a near-name is not a match', async () => {
  const { namesPerson } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
  const names = ['a.b@zztest.example', 'Ann Zztest', 'Bo', 'will']
  for (const t of ['Ann Zztest has the most open gates', 'ann zztest has the most open gates', 'Ann\nZztest took 9 hours', 'Bo has the most open gates.', '(Bo)', 'Bo’s gates', 'mail a.b@zztest.example', 'Will approved it']) assert.equal(namesPerson(t, names), true, t)
  for (const t of ['Bob has gates', 'the bot ran', 'a bo-like word', 'Ann Zztester ran', 'this run will finish', 'bo has the gates', 'xa.b@zztest.example', '', undefined]) assert.equal(namesPerson(t, names), false, String(t))
  assert.equal(namesPerson('Ann Zztest', []), false, 'no names, nothing to match')
})

test('U16 (review 5): the forwarder withholds an answer that names a person — text and refs — logs that it did without the name, and leaves refusals and clean answers alone', async () => {
  let reply = { status: 200, body: { ...cases.answer.body, answer: 'Ann Zztest has the most open gates.' } }
  const worker = await standIn(() => reply)
  const logs = []
  try {
    const ask = createAsk(cfgFor(worker.url), { log: (l) => logs.push(l), knownNames: () => ['Ann Zztest'] })
    const w = await ask.ask({ question: 'q' })
    assert.deepEqual([w.status, w.body.reason, w.body.answer, w.body.based_on], [200, 'named_person', 'Withheld: it named a person.', []])
    assert.deepEqual(validate(schema, w.body), [])
    assert.match(logs.at(-1), /^ask: 200 withheld \(named a person\)/)
    assert.ok(!logs.join('\n').includes('Ann'), 'the name is never logged')
    reply = { status: 200, body: { ...cases.answer.body, based_on: [{ ref: 'x', label: 'taps by Ann Zztest', read: true }] } }
    assert.equal((await ask.ask({ question: 'q' })).body.reason, 'named_person', 'a ref that names one counts too')
    reply = { status: 200, body: cases.refusal_guard.body }
    assert.equal((await ask.ask({ question: 'q' })).body.reason, 'annex_iii', 'a refusal is the Worker\'s own text, untouched')
    reply = { status: 200, body: cases.answer.body }
    assert.deepEqual((await ask.ask({ question: 'q' })).body, cases.answer.body)
    const broken = createAsk(cfgFor(worker.url), { knownNames: () => { throw new Error('no scan yet') } })
    assert.deepEqual((await broken.ask({ question: 'q' })).body, cases.answer.body, 'no names to check against: the Worker\'s own check stands')
  } finally {
    await worker.close()
  }
})

test('U16W (confirmation review 4): the bearer is cut out BEFORE any string is cut short — one straddling the 1000-character detail or the 20,000-character answer leaks no part of itself', async () => {
  const { normaliseAnswer, normaliseError, secretsOf } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
  const T = 'Qk7vRtb-bearer-0123456789abcdef'
  const secrets = secretsOf(T)
  const head = T.slice(0, 6)
  // the token starts 4 characters before each cut, so a cut-then-strip keeps those 4 (and the first 6 are checked)
  const err = normaliseError(502, { error: 'provider_failed', detail: `${'d'.repeat(996)}${T} and after` }, null, { secrets })
  assert.ok(!err.detail.includes(head) && !err.detail.includes(T.slice(0, 4)), `detail leaks nothing: …${err.detail.slice(-20)}`)
  const ans = normaliseAnswer({ ...cases.answer.body, answer: `${'a'.repeat(19_996)}${T} and after`, based_on: [{ ref: `${'r'.repeat(296)}${T}`, label: `${'l'.repeat(296)}${T}`, read: true }] }, { secrets })
  assert.ok(!ans.answer.includes(T.slice(0, 4)), `answer leaks nothing: …${ans.answer.slice(-20)}`)
  assert.ok(!ans.based_on[0].label.includes(T.slice(0, 4)) && !ans.based_on[0].ref.includes(T.slice(0, 4)), 'nor the refs')
  const code = normaliseError(400, { error: `${'e'.repeat(76)}${T}` }, null, { secrets })
  assert.ok(!code.error.includes(T.slice(0, 4)), 'nor the error code')
})
