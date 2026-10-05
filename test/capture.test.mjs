// Agent World — scripts/capture-contract.sh --cost-only: re-capture GET /ledger/cost?days=1 for the contract test
// (spec/ledger-cost.v1.json, U37) once Compass U5 is deployed. Run here against a local stand-in for the Worker, with
// .env never read (CAPTURE_SKIP_DOTENV=1) and the output in a temporary directory — never the real Worker.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { validate } from './lib/validate.mjs'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))
const BEARER = 'zztest-capture-bearer'

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(root, 'scripts/capture-contract.sh'), ...args], { env, cwd: os.tmpdir() })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

async function fakeWorker(answer) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization })
    const [status, body] = answer(req)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { requests, url: `http://127.0.0.1:${server.address().port}/events`, close: () => new Promise((r) => server.close(r)) }
}

const SYNTHETIC = read('test/fixtures/ledger-cost.synthetic.json')
const REAL = 'Real Client Trading LLC'
/** Run --cost-only against a stand-in Worker answering `answer`; returns the exit code, the output and the file (or null). */
async function capture(answer) {
  const w = await fakeWorker((req) => (req.url.startsWith('/ledger/cost') ? [200, answer] : [404, { error: 'no' }]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-capture-'))
  try {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), EVENTS_URL: w.url, EVENTS_BEARER_TOKEN: BEARER, CAPTURE_DIR: dir, CAPTURE_SKIP_DOTENV: '1' }
    const { code, out } = await run(['--cost-only'], env)
    const file = path.join(dir, 'ledger-cost.live.json')
    return { code, out, requests: w.requests, files: fs.readdirSync(dir), text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }
  } finally {
    await w.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('--cost-only captures GET /ledger/cost?days=1&include_test=1: GET only, the bearer in the header and nowhere else, every real town replaced, the rest kept only where its shape is known', { timeout: 20000 }, async () => {
  // The Worker's own shape (tellefsen-compass-mcp src/lib/ledger-row-endpoints.ts on main): by_town[] and by_town_day[]
  // each name a town; pricing_version is free text after its version (the live MODEL_PRICING reads like this).
  const row = SYNTHETIC.by_town[0]
  const day = SYNTHETIC.by_town_day[0]
  const answer = {
    ...SYNTHETIC,
    pricing_version: '0.2 · 2026-09-08 (ES-4.13; Decision reference, Real Client Trading LLC)',
    by_town: [...SYNTHETIC.by_town, { ...row, town: REAL }, { ...row, town: 'Tellefsen Venture One' }],
    by_town_day: [...SYNTHETIC.by_town_day, { ...day, town: REAL }, { ...day, town: 'Tellefsen Venture One' }],
  }
  const { code, out, requests, files, text } = await capture(answer)
  assert.equal(code, 0, out)
  assert.deepEqual(requests, [{ method: 'GET', url: '/ledger/cost?days=1&include_test=1', auth: `Bearer ${BEARER}` }], 'one GET, nothing else read')
  assert.ok(!out.includes(BEARER), 'the bearer is never printed')
  assert.match(out, /cost captured: \d+ runs, \d+ towns, 2 town names replaced/)
  assert.deepEqual(files, ['ledger-cost.live.json'], 'only the cost capture is written')
  assert.ok(!/Real|Venture|Decision reference/.test(text), 'no real name, nor any free text, survives')
  const got = JSON.parse(text)
  assert.deepEqual(validate(read('spec/ledger-cost.v1.json'), got), [], 'the capture is what the contract test validates')
  assert.deepEqual(got.by_town.map((r) => r.town), ['ZZTEST Client', 'internal', 'ZZTEST Idle', 'town-1', 'town-2'])
  assert.deepEqual(got.by_town_day.map((r) => r.town), ['ZZTEST Client', 'ZZTEST Idle', 'internal', 'town-1', 'town-2'], 'the same stand-in in both lists')
  assert.equal(got.pricing_version, '0.2 · 2026-09-08', 'the version and its date, not the free text after them')
  assert.deepEqual(got.totals, SYNTHETIC.totals, 'the figures are the Worker\'s, untouched')
  for (const k of ['at', 'days', 'since', 'town_source', 'excluded_test_runs']) assert.deepEqual(got[k], SYNTHETIC[k], k)
  assert.deepEqual(got.by_town_day.map((r) => r.day), answer.by_town_day.map((r) => r.day))
})

test('--cost-only refuses to write anything when a key appears where the contract has none — at any depth — and says which', { timeout: 30000 }, async () => {
  const row = SYNTHETIC.by_town[0]
  const day = SYNTHETIC.by_town_day[0]
  const cases = [
    ['$.by_town[3].at', { ...SYNTHETIC, by_town: [...SYNTHETIC.by_town, { ...row, at: REAL }] }],
    ['$.by_town_day[3].since', { ...SYNTHETIC, by_town_day: [...SYNTHETIC.by_town_day, { ...day, since: REAL }] }],
    ['$.totals.town_source', { ...SYNTHETIC, totals: { ...SYNTHETIC.totals, town_source: REAL } }],
    ['$.extra', { ...SYNTHETIC, extra: { day: REAL } }],
    ['$.extra', { ...SYNTHETIC, extra: { nested: { pricing_version: REAL } } }],
    ['$.by_town_day[3].client_label', { ...SYNTHETIC, by_town_day: [...SYNTHETIC.by_town_day, { ...day, client_label: REAL }] }],
    ['$.extra', { ...SYNTHETIC, extra: { [REAL]: { cost_usd: 1 } } }],
  ]
  for (const [where, answer] of cases) {
    const { code, out, files } = await capture(answer)
    assert.notEqual(code, 0, where)
    assert.deepEqual(files, [], `${where}: nothing written`)
    assert.ok(out.includes(`unknown key at ${where}`), `${where} is named: ${out}`)
    assert.match(out, /nothing written/)
    assert.ok(!out.includes(REAL), `${where}: the value is never printed`)
  }
})

test('--cost-only keeps a string at a known path only in its expected shape: anything else is redacted, and said', { timeout: 30000 }, async () => {
  const day = SYNTHETIC.by_town_day[0]
  const cases = [
    ['$.pricing_version', { ...SYNTHETIC, pricing_version: [REAL] }, (g) => g.pricing_version === 'redacted'],
    ['$.pricing_version', { ...SYNTHETIC, pricing_version: REAL }, (g) => g.pricing_version === 'redacted'],
    ['$.at', { ...SYNTHETIC, at: REAL }, (g) => g.at === 'redacted'],
    ['$.since', { ...SYNTHETIC, since: { when: REAL } }, (g) => g.since === 'redacted'],
    ['$.town_source', { ...SYNTHETIC, town_source: REAL }, (g) => g.town_source === 'redacted'],
    ['$.by_town_day[0].day', { ...SYNTHETIC, by_town_day: [{ ...day, day: REAL }] }, (g) => g.by_town_day[0].day === 'redacted'],
    ['$.totals.runs_total', { ...SYNTHETIC, totals: { ...SYNTHETIC.totals, runs_total: REAL } }, (g) => g.totals.runs_total === 'redacted'],
    ['$.by_town[0].town', { ...SYNTHETIC, by_town: [{ ...SYNTHETIC.by_town[0], town: { name: REAL } }] }, (g) => g.by_town[0].town === 'redacted'],
  ]
  for (const [where, answer, check] of cases) {
    const { code, out, text } = await capture(answer)
    assert.equal(code, 0, `${where}: ${out}`)
    assert.ok(text && !text.includes(REAL) && !text.includes('Real'), `${where}: no real name in the file`)
    assert.ok(check(JSON.parse(text)), `${where}: redacted`)
    assert.ok(out.includes(`redacted ${where}`), `${where} is said: ${out}`)
    assert.ok(!out.includes(REAL), `${where}: the value is never printed`)
  }
})

test('--cost-only against a Worker without the route fails plainly, writes nothing, and never prints the bearer', { timeout: 20000 }, async () => {
  const w = await fakeWorker(() => [404, { error: 'Not found' }])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-capture-'))
  try {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), EVENTS_URL: w.url, EVENTS_BEARER_TOKEN: BEARER, CAPTURE_DIR: dir, CAPTURE_SKIP_DOTENV: '1' }
    const { code, out } = await run(['--cost-only'], env)
    assert.notEqual(code, 0)
    assert.match(out, /GET \/ledger\/cost did not answer 200 — is Compass U5 deployed\?/)
    assert.ok(!out.includes(BEARER))
    assert.deepEqual(fs.readdirSync(dir), [], 'nothing written')
    const bad = await run(['--everything'], env)
    assert.equal(bad.code, 2, 'an unknown mode is refused')
    assert.match(bad.out, /usage/)
  } finally {
    await w.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
