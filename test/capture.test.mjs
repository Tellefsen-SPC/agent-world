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

test('--cost-only captures GET /ledger/cost?days=1&include_test=1 into ledger-cost.live.json: GET only, the bearer in the header and nowhere else, and no real place name anywhere in the file', { timeout: 20000 }, async () => {
  // The Worker's own shape (tellefsen-compass-mcp src/lib/ledger-row-endpoints.ts on main): by_town[] and by_town_day[],
  // each row naming its town — plus two things a later Worker might add: a string field nobody listed, and an object
  // keyed by a name. Only keys known to be safe keep their strings; every other string and every unknown key is replaced.
  const synthetic = read('test/fixtures/ledger-cost.synthetic.json')
  const REAL = ['Real Client Trading LLC', 'Another Real Co', 'Hidden Name GmbH', 'Tellefsen Venture One']
  const row = synthetic.by_town[0]
  const day = synthetic.by_town_day[0]
  const answer = {
    ...synthetic,
    by_town: [...synthetic.by_town, { ...row, town: REAL[0] }, { ...row, town: REAL[3] }],
    by_town_day: [...synthetic.by_town_day, { ...day, town: REAL[0] }, { ...day, town: REAL[3], client_label: REAL[1] }],
    extra: { [REAL[2]]: { cost_usd: 1 } },
  }
  const w = await fakeWorker((req) => (req.url.startsWith('/ledger/cost') ? [200, answer] : [404, { error: 'no' }]))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-capture-'))
  try {
    const env = { PATH: process.env.PATH, HOME: os.tmpdir(), EVENTS_URL: w.url, EVENTS_BEARER_TOKEN: BEARER, CAPTURE_DIR: dir, CAPTURE_SKIP_DOTENV: '1' }
    const { code, out } = await run(['--cost-only'], env)
    assert.equal(code, 0, out)
    assert.deepEqual(w.requests, [{ method: 'GET', url: '/ledger/cost?days=1&include_test=1', auth: `Bearer ${BEARER}` }], 'one GET, nothing else read')
    assert.ok(!out.includes(BEARER), 'the bearer is never printed')
    assert.match(out, /cost captured: \d+ runs, \d+ towns/)
    assert.match(out, /3 unknown keys renamed/, 'an unknown key is reported, so a contract change is not missed')
    assert.deepEqual(fs.readdirSync(dir), ['ledger-cost.live.json'], 'only the cost capture is written')
    const text = fs.readFileSync(path.join(dir, 'ledger-cost.live.json'), 'utf8')
    for (const name of REAL) assert.ok(!text.includes(name), `${name} does not land in a public fixture`)
    assert.ok(!/Real|Hidden|Another|Venture/.test(text), 'not even a fragment')
    const got = JSON.parse(text)
    const { extra: _e, ...shape } = got
    assert.deepEqual(validate(read('spec/ledger-cost.v1.json'), shape), [], 'the capture is what the contract test validates')
    assert.match(got.note, /GET \/ledger\/cost\?days=1&include_test=1 captured \d{4}-\d{2}-\d{2}/)
    // ZZTEST towns and internal are kept; each real town has one stand-in, the same in by_town and by_town_day
    const towns = got.by_town.map((r) => r.town)
    assert.deepEqual(towns, ['ZZTEST Client', 'internal', 'ZZTEST Idle', 'town-1', 'town-2'])
    assert.deepEqual(got.by_town_day.map((r) => r.town), ['ZZTEST Client', 'ZZTEST Idle', 'internal', 'town-1', 'town-2'])
    assert.equal(got.by_town_day[4].client_label, undefined, 'an unknown key does not keep its name')
    // the figures, the day, the times and the enums are the Worker's, untouched
    assert.deepEqual(got.totals, synthetic.totals)
    assert.deepEqual(got.by_town_day.map((r) => r.day), answer.by_town_day.map((r) => r.day))
    for (const k of ['at', 'days', 'since', 'pricing_version', 'town_source', 'excluded_test_runs']) assert.deepEqual(got[k], synthetic[k], k)
  } finally {
    await w.close()
    fs.rmSync(dir, { recursive: true, force: true })
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
