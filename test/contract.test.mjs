// Agent World — U34: contract v1. The schemas validate the captured Worker responses and the packs;
// the adapter reads exactly five Worker routes (U35 added /world/spend, ES-4.13; U37 /ledger/cost, from Compass U5;
// U7 /events/stream, the ledger as server-sent events — the realtime nudge, 2026-10-04) and asks one, the sixth:
// POST /ask (U16W wiring, ES-4.6, 2026-10-05), from compass/ask.mjs only, behind the sidecar (docs/adr/0008).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { validate } from './lib/validate.mjs'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))

test('U34: spec/world-substrate.v1.json validates the captured GET /world/substrate', () => {
  const errs = validate(read('spec/world-substrate.v1.json'), read('test/fixtures/m2b-substrate.live.json'))
  assert.deepEqual(errs, [])
})

test('U35/U36: spec/world-spend.v1.json validates the captured GET /world/spend, refuses a bucket short of a counter and a malformed est', () => {
  const schema = read('spec/world-spend.v1.json')
  const live = read('test/fixtures/m2b-spend.live.json')
  assert.deepEqual(validate(schema, live), [])
  assert.ok(validate(schema, { ...live, totals: { runs_total: 1 } }).some((e) => /totals.*runs_metered/.test(e)))
  assert.ok(validate(schema, { ...live, by_client: [{ runs_total: 0 }] }).some((e) => /by_client\[0\].*client/.test(e)))
  assert.ok(!JSON.stringify(live).includes('"actor"'), 'the captured response carries no per-person field')
  // U36: estimates_version and the est objects — optional in the schema, present in the capture; a malformed est is refused
  assert.equal(typeof live.estimates_version, 'string')
  assert.ok(live.by_client.some((r) => r.est) && live.totals.est, 'the capture carries estimates')
  const est = live.by_client.find((r) => r.est)
  assert.ok(validate(schema, { ...live, by_client: [{ ...est, est: { tokens_in_est: 1 } }] }).some((e) => /by_client\[0\]\.est.*cost_usd_est/.test(e)))
  assert.ok(validate(schema, { ...live, by_client: [{ ...est, est: { ...est.est, confidence: 'sure' } }] }).some((e) => /est\.confidence/.test(e)))
  assert.ok(validate(schema, { ...live, by_client: [{ ...est, est: { ...est.est, cost_usd_est: -1 } }] }).some((e) => /est\.cost_usd_est/.test(e)))
  const { est: _drop, ...bare } = est
  const { estimates_version: _v, ...without } = live
  const { est: _t, ...totals } = live.totals
  assert.deepEqual(validate(schema, { ...without, by_client: [bare], totals }).filter((e) => /est/.test(e)), [], 'est and estimates_version are optional')
})

test('U34: spec/ledger-scan.v1.json validates the captured GET /ledger/scan, and refuses a shape that is not the ledger', () => {
  const schema = read('spec/ledger-scan.v1.json')
  assert.deepEqual(validate(schema, read('test/fixtures/m2b-ledger-scan.live.json')), [])
  assert.ok(validate(schema, { events: [{ id: 'x', run_id: 'r', at: 't', event_type: 'made_up', skill: 's' }], rows: [] }).some((e) => /event_type/.test(e)))
  assert.ok(validate(schema, { events: [] }).some((e) => /rows/.test(e)))
})

test('U37: spec/ledger-cost.v1.json validates GET /ledger/cost as the Worker answers it, and refuses a bucket short of a counter or a town with no name', () => {
  const schema = read('spec/ledger-cost.v1.json')
  // Synthetic until a live capture exists: the Worker's own handler (Compass U5) run over ZZTEST rows.
  const answer = read('test/fixtures/ledger-cost.synthetic.json')
  assert.deepEqual(validate(schema, answer), [])
  assert.ok(validate(schema, { ...answer, by_town: [{ town: 'ZZTEST Client', runs_total: 1 }] }).some((e) => /by_town\[0\].*cost_usd/.test(e)))
  assert.ok(validate(schema, { ...answer, by_town: [{ ...answer.by_town[0], town: '' }] }).some((e) => /by_town\[0\]\.town/.test(e)))
  assert.ok(validate(schema, { ...answer, town_source: 'person' }).some((e) => /town_source/.test(e)))
  assert.ok(!JSON.stringify(answer).includes('"actor"'), 'no per-person field')
})

test('U37: the live GET /ledger/cost capture validates too, once scripts/capture-contract.sh --cost-only has made one', (t) => {
  const live = 'test/fixtures/ledger-cost.live.json'
  if (!fs.existsSync(path.join(root, live))) return t.skip('not captured yet: Compass U5 is not deployed (docs/CONTRACT.md)')
  assert.deepEqual(validate(read('spec/ledger-cost.v1.json'), read(live)), [])
  assert.ok(!JSON.stringify(read(live)).includes('"actor"'), 'no per-person field')
})

test('U16W: spec/ask.v1.json — the sidecar cuts every answer and error the Worker gives (compass-ask, synthetic) to the schema; the schema refuses an answer without its keys, a stray key and a person-shaped field', async () => {
  const { normaliseAnswer, normaliseError, retryAfterOf } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
  const schema = read('spec/ask.v1.json')
  const cases = read('test/fixtures/ask.synthetic.json')
  let answers = 0
  let errors = 0
  for (const [name, c] of Object.entries(cases)) {
    if (name.startsWith('_')) continue
    if (c.status === 200) {
      const cut = normaliseAnswer(c.body)
      assert.deepEqual(validate(schema, cut), [], name)
      assert.deepEqual(cut, c.body, `${name}: an answer already in the contract's shape passes through unchanged`)
      answers++
    } else {
      const cut = normaliseError(c.status, c.body, c.retry_after === undefined ? null : retryAfterOf(c.retry_after))
      assert.deepEqual(validate(schema.$defs.error, cut), [], name)
      for (const k of Object.keys(cut)) assert.ok(k in schema.$defs.error.properties, `${name}: ${k} is a contract key`)
      errors++
    }
  }
  assert.ok(answers >= 3 && errors >= 8, 'an answer, two refusals and the error statuses')
  // the budget's wait rides on the body as whole seconds
  assert.equal(normaliseError(429, cases.budget.body, retryAfterOf(cases.budget.retry_after)).retry_after, 15120)
  // a Worker body with a key the contract has not got: the raw body fails the schema; the cut drops the key
  const stray = { ...cases.answer.body, actor: 'someone', note: 'not in the contract' }
  assert.ok(validate(schema, stray).some((e) => /unexpected "actor"/.test(e)))
  assert.deepEqual(validate(schema, normaliseAnswer(stray)), [])
  assert.ok(!('actor' in normaliseAnswer(stray)), 'no person-shaped field survives the cut')
  assert.ok(validate(schema.$defs.error, cases.provider_failed.body).some((e) => /unexpected "ledger"/.test(e)), 'the raw provider error carries a key the panel does not get')
  // an answer short of its keys, or with a provider outside the enum, is refused
  const { run_id: _r, ...noRun } = cases.answer.body
  assert.ok(validate(schema, noRun).some((e) => /missing required "run_id"/.test(e)))
  assert.ok(validate(schema, { ...cases.answer.body, provider: 'someone-else' }).some((e) => /provider/.test(e)))
  assert.ok(!/actor/i.test(JSON.stringify(schema)), 'the schema names no person-shaped field')
})

test('U34: spec/pack.v1.json validates both shipped packs and carries figure ∈ {character, marker}', () => {
  const schema = read('spec/pack.v1.json')
  for (const id of ['tellefsen-campus', 'neutral']) assert.deepEqual(validate(schema, read(`overlay/packs/${id}/pack.json`)), [], id)
  assert.deepEqual(schema.properties.figure.enum, ['character', 'marker'])
  const bad = { ...read('overlay/packs/neutral/pack.json'), figure: 'sprite' }
  assert.ok(validate(schema, bad).some((e) => /figure/.test(e)))
  for (const k of ['skin', 'rooms', 'names', 'lod', 'layout', 'figure']) assert.ok(schema.required.includes(k), k)
  assert.deepEqual(schema.properties.rooms.items.required, ['id', 'name', 'mirrors', 'surface', 'ring', 'spoke'])
})

/** Every Worker route the adapter's code names. */
const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.m?js$/.test(name)) out.push(p)
  }
  return out
}
test('U34/U35/U37/U7/U16: the adapter reads only /ledger/scan, /world/substrate, /world/spend, /ledger/cost and /events/stream, and asks only /ask — six routes; any other Worker route in server/harnesses/compass* fails', () => {
  const files = [path.join(root, 'server/harnesses/compass.mjs'), ...walk(path.join(root, 'server/harnesses/compass'))]
  const allowed = new Set(['/ledger/scan', '/world/substrate', '/world/spend', '/ledger/cost', '/events/stream', '/ask'])
  assert.equal(allowed.size, 6, 'six Worker routes: five reads and the PA')
  const WORKER_FIELD = /ledgerUrl|substrateUrl|spendUrl|ledgerCostUrl|streamUrl|askUrl|eventsUrl/
  const hits = []
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // the sidecar (overlay-api.mjs) serves its own loopback routes (/world, /rooms …) and never fetches anything: it is a listener, not a reader
    if (path.basename(f) === 'overlay-api.mjs') {
      assert.ok(!/\bfetch(Impl)?\s*\(/.test(text) && !/https?\.(get|request)\s*\(/.test(text), 'overlay-api.mjs must not fetch or request')
      continue
    }
    // a Worker URL is built in config.mjs and nowhere else: no other file may touch eventsUrl or assemble one from a Worker field
    if (path.basename(f) !== 'config.mjs') {
      assert.ok(!/eventsUrl/.test(text), `${path.relative(root, f)} references eventsUrl — Worker URLs are config.mjs's to derive`)
      assert.ok(!/(ledgerUrl|substrateUrl|spendUrl|ledgerCostUrl|streamUrl|askUrl)\s*\.\s*(replace|slice|split|concat)\(/.test(text), `${path.relative(root, f)} rebuilds a Worker URL from a derived field`)
      // U37: every Worker URL assembled anywhere — whatever it is then handed to (a variable, a retry, a cache) — is one of the reads
      // (U7: the stream URL is never assembled: it is requested verbatim, the resume point travels in Last-Event-ID)
      // (U16: the ask URL is never assembled either: the question travels in the POST body)
      for (const m of text.matchAll(/`\$\{cfg\.(?:ledgerUrl|substrateUrl|spendUrl|ledgerCostUrl|streamUrl|askUrl)\}[^`]*`/g)) {
        const url = m[0]
        assert.ok(url.startsWith('`${cfg.ledgerUrl}?since=') || url.startsWith('`${cfg.spendUrl}?window=') || url.startsWith('`${cfg.ledgerCostUrl}?days=1'), `${path.relative(root, f)} assembles a Worker URL that is not one of the reads: ${url}`)
      }
      // every fetch of a Worker field is one of the reads, verbatim — straight to fetch, or through spend.mjs's cached(url, …) (U37)
      for (const m of text.matchAll(/(?:fetch(?:Impl)?|cached)\s*\(\s*([^,)]+)/g)) {
        const arg = m[1].trim()
        if (!WORKER_FIELD.test(arg)) continue
        // U16: the PA's question goes to cfg.askUrl verbatim, and only from compass/ask.mjs (the one POST — invariants.test.mjs)
        if (arg === 'cfg.askUrl') {
          assert.equal(path.basename(f), 'ask.mjs', `${path.relative(root, f)} asks the Worker's /ask — only compass/ask.mjs may`)
          continue
        }
        assert.ok(arg === 'cfg.substrateUrl' || arg.startsWith('`${cfg.ledgerUrl}?since=') || arg.startsWith('`${cfg.spendUrl}?window=') || arg.startsWith('`${cfg.ledgerCostUrl}?days=1'), `${path.relative(root, f)} fetches a Worker URL that is not one of the reads: ${arg}`)
      }
      // U7: a request made with node:http(s) — .get( / .request( — on a Worker field is the stream, verbatim, and only from stream.mjs
      for (const m of text.matchAll(/\.(?:get|request)\s*\(\s*([^,)]+)/g)) {
        const arg = m[1].trim()
        if (!WORKER_FIELD.test(arg)) continue
        assert.ok(arg === 'cfg.streamUrl' && path.basename(f) === 'stream.mjs', `${path.relative(root, f)} requests a Worker URL that is not the stream, verbatim: ${arg}`)
      }
      assert.ok(!/\b(?:http|https)\.request\s*\(/.test(text), `${path.relative(root, f)} uses http.request — the adapter's one node:http call is the stream's GET`)
    }
    for (const m of text.matchAll(/\/(?:ledger|world|ask|actions|events)(?:\/[a-z0-9_-]+)?\b/g)) {
      const route = m[0]
      // config.mjs derives the two allowed routes from EVENTS_URL by replacing its `/events` tail — that mention is the derivation, not a read
      if (route === '/events' && path.basename(f) === 'config.mjs' && /replace\(\/\\\/events\$\//.test(text)) continue
      if (!allowed.has(route)) hits.push(`${path.relative(root, f)}: ${route}`)
    }
  }
  assert.deepEqual(hits, [], `Worker routes outside the contract:\n${hits.join('\n')}`)
})
