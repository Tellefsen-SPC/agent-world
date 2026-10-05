// Agent World — U35: spend per town and room (ES-4.13). The fold reconciles, the numbers read right, an unmetered place
// never reads $0, the line is Owner-only and pack-gated, no "actor" anywhere on the path, the hook sums a transcript,
// the sidecar serves /spend, the reader caches and keeps its last good answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))
const live = read('test/fixtures/m2b-spend.live.json')
const b = (over) => ({ runs_total: 0, runs_metered: 0, runs_unmetered: 0, runs_unpriced: 0, tokens_in: 0, tokens_out: 0, tokens_unpriced: 0, cost_usd: 0, ...over })

test('U35: the fold reconciles — campusRooms + elsewhere = campus, towns + campus = planet — on the captured response and on a synthetic one with towns, an unknown client and an override; a room\'s line is its skills\' spend across every client', async () => {
  const { foldSpend, reconcile, sum, add, bucket } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const pack = loadPack('tellefsen-campus')
  // the captured live response: one client ("internal"), fifty unmetered runs
  const f = foldSpend(live, { pack, towns: [], planet: 'tellefsen', home: 'tellefsen' })
  assert.deepEqual(reconcile(f), { roomsPlusElsewhereIsCampus: true, townsPlusCampusIsPlanet: true })
  const internal = live.by_client.find((r) => r.client === 'internal')
  assert.equal(f.campus.runs_total, internal.runs_total, 'the campus is the internal client, folded into rooms')
  assert.equal(f.campus.cost_usd, internal.cost_usd)
  assert.equal(f.planet.runs_total, live.totals.runs_total, 'no town: the planet is the campus, which is the totals')
  assert.equal(f.rooms.get('records-office').runs_total, live.by_skill.filter((r) => r.type === 'Operations').reduce((n, r) => n + r.runs_total, 0), 'Operations → records office by type')
  assert.equal(f.campusRooms.get('records-office').runs_total, live.by_client_skill.filter((r) => r.client === 'internal' && r.type === 'Operations').reduce((n, r) => n + r.runs_total, 0))
  // synthetic: two towns on two planets, an unknown client, internal rows across the rule's three branches
  const body = {
    at: 'x', window_days: 30, display: { omr_per_usd: 0.3845 },
    by_client: [
      b({ client: 'internal', runs_total: 4, runs_metered: 3, runs_unmetered: 1, tokens_in: 400, tokens_out: 40, cost_usd: 1.5 }),
      b({ client: 'Town A', runs_total: 2, runs_metered: 2, tokens_in: 100, tokens_out: 10, cost_usd: 0.25 }),
      b({ client: 'Town B', runs_total: 1, runs_metered: 1, tokens_in: 50, tokens_out: 5, cost_usd: 0.1 }),
      b({ client: 'Nobody Ltd', runs_total: 3, runs_metered: 0, runs_unmetered: 3 }),
    ],
    by_client_skill: [
      b({ client: 'internal', skill: 'zztest-stale-expert', type: 'Delivery', runs_total: 1, runs_metered: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }), // override wins over type
      b({ client: 'internal', skill: 'zztest-spend', type: 'Research', runs_total: 1, runs_metered: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }),
      b({ client: 'internal', skill: 'zztest-unknown-type', type: 'Mystery', runs_total: 1, runs_metered: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }), // default room
      b({ client: 'internal', skill: 'zztest-nothing', type: null, runs_total: 1, runs_metered: 0, runs_unmetered: 1, tokens_in: 100, tokens_out: 10 }),
      b({ client: 'Town A', skill: 'zztest-spend', type: 'Research', runs_total: 2, runs_metered: 2, tokens_in: 100, tokens_out: 10, cost_usd: 0.25 }),
    ],
    by_skill: [
      b({ skill: 'zztest-stale-expert', type: 'Delivery', runs_total: 1, runs_metered: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }),
      b({ skill: 'zztest-spend', type: 'Research', runs_total: 3, runs_metered: 3, tokens_in: 200, tokens_out: 20, cost_usd: 0.75 }), // internal + Town A
      b({ skill: 'zztest-unknown-type', type: 'Mystery', runs_total: 1, runs_metered: 1, tokens_in: 100, tokens_out: 10, cost_usd: 0.5 }),
      b({ skill: 'zztest-nothing', type: null, runs_total: 1, runs_metered: 0, runs_unmetered: 1, tokens_in: 100, tokens_out: 10 }),
    ],
    by_model: [],
    totals: b({ runs_total: 10, runs_metered: 6, runs_unmetered: 4, tokens_in: 550, tokens_out: 55, cost_usd: 1.85 }),
  }
  const towns = [{ name: 'Town A', planet: 'home' }, { name: 'Town B', planet: 'other' }]
  const home = foldSpend(body, { pack, towns, planet: 'home', home: 'home' })
  assert.deepEqual(reconcile(home), { roomsPlusElsewhereIsCampus: true, townsPlusCampusIsPlanet: true })
  assert.deepEqual([...home.towns.keys()], ['Town A'], 'only this planet\'s towns')
  assert.equal(home.rooms.get('records-office').cost_usd, 0.5, 'zztest-stale-expert: the pack override → records office, not the Delivery type')
  assert.equal(home.rooms.get('research-lab').cost_usd, 0.75, 'type Research → research lab: the skill\'s spend across every client (Iota reads here)')
  assert.equal(home.rooms.get('research-lab').runs_total, 3)
  assert.equal(home.campusRooms.get('research-lab').cost_usd, 0.5, 'the campus fold: the internal client\'s share only')
  assert.equal(home.rooms.get('workshop').runs_total, 2, 'an unknown type and a null type → the default room')
  assert.equal(home.elsewhere.runs_total, 3, 'a client with no town anywhere is rendered under elsewhere, never dropped')
  assert.equal(home.campus.runs_total, 7); assert.equal(home.campus.cost_usd, 1.5)
  assert.equal(home.planet.runs_total, 9); assert.equal(home.planet.cost_usd, 1.75)
  const other = foldSpend(body, { pack, towns, planet: 'other', home: 'home' })
  assert.deepEqual(reconcile(other), { roomsPlusElsewhereIsCampus: true, townsPlusCampusIsPlanet: true })
  assert.equal(other.campus.runs_total, 0, 'another planet has no campus')
  assert.equal([...other.rooms.values()].reduce((n, r) => n + r.runs_total, 0), 0, 'and no room lines')
  assert.deepEqual([...other.towns.keys()], ['Town B'])
  assert.equal(other.planet.cost_usd, 0.1)
  const all = add(add(bucket(), home.planet), other.planet)
  assert.equal(all.runs_total, body.totals.runs_total, 'the planets together are the totals')
  assert.equal(all.cost_usd, body.totals.cost_usd)
  assert.equal(sum([]).runs_total, 0)
})

test('U35: numbers — 84k, 1.2M, $18.40; OMR multiplies by display.omr_per_usd from the response, never a peg of its own', async () => {
  const { compact, money, windowLabel } = await import(path.join(root, 'overlay/spend.mjs'))
  assert.deepEqual([84000, 1_200_000, 327000, 950, 9500, 10000, 12_345_678, 0].map(compact), ['84k', '1.2M', '327k', '950', '9.5k', '10k', '12M', '0'])
  assert.equal(money(18.4), '$18.40')
  assert.equal(money(0.6125), '$0.61')
  assert.equal(money(0.001), '$0.0010', 'a cost that would print as zero gets two more places')
  assert.equal(money(0), '$0.00')
  assert.equal(money(10, { currency: 'OMR', omrPerUsd: 0.3845 }), '3.845 OMR')
  assert.equal(money(10, { currency: 'OMR', omrPerUsd: null }), '$10.00', 'no peg in the response → dollars (the world holds none)')
  assert.equal(windowLabel(30), '30d'); assert.equal(windowLabel('all'), 'all'); assert.equal(windowLabel(null), '?d')
})

test('U35: the line — runs_metered 0 reads "unmetered", never $0; the unmetered and unpriced counts ride on the same line; Iota reads 327k / $0.61', async () => {
  const { spendLine } = await import(path.join(root, 'overlay/spend.mjs'))
  const opts = { window: 30, currency: 'USD' }
  const unmetered = spendLine(b({ runs_total: 5, runs_unmetered: 5 }), opts)
  assert.equal(unmetered, 'Tokens 0 · unmetered · 30d · 5 of 5 runs unmetered')
  assert.ok(!/\$0/.test(unmetered))
  assert.equal(spendLine(b({ runs_total: 5, runs_metered: 3, runs_unmetered: 2, runs_unpriced: 1, tokens_in: 80_000, tokens_out: 4_000, cost_usd: 18.4 }), opts), 'Tokens 84k · $18.40 · 30d · 2 of 5 runs unmetered · 1 unpriced')
  assert.equal(spendLine(b({ runs_total: 2, runs_metered: 2, tokens_in: 315_000, tokens_out: 12_000, cost_usd: 0.6125 }), opts), 'Tokens 327k · $0.61 · 30d', 'fixture Iota: flat 110k + breakdown 217k, $0.30 + $0.3125')
  assert.equal(spendLine(b({ runs_total: 1, runs_metered: 1, tokens_in: 1_000_000, tokens_out: 200_000, cost_usd: 10 }), { window: 30, currency: 'OMR', omrPerUsd: 0.3845 }), 'Tokens 1.2M · 3.845 OMR · 30d')
  assert.equal(spendLine(null, opts), '')
})

test('U35: Owner-only — any other preset gets nothing, not a blank line; the neutral pack shows nothing even to the Owner', async () => {
  const { spendLineFor, showSpend, foldSpend } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const campus = loadPack('tellefsen-campus'); const neutral = loadPack('neutral')
  assert.deepEqual(campus.spend, { show: true, window_days: 30, currency: 'USD', estimates: true }); assert.deepEqual(neutral.spend, { show: false }) // estimates: U36
  const fold = foldSpend(live, { pack: campus, towns: [], planet: 'tellefsen', home: 'tellefsen' })
  const bucket = b({ runs_total: 1, runs_metered: 1, tokens_in: 1000, tokens_out: 100, cost_usd: 0.05 })
  assert.equal(spendLineFor(bucket, { viewer: { preset: 'owner' }, pack: campus, fold }), 'Tokens 1.1k · $0.05 · 30d')
  for (const preset of ['operator', 'viewer', 'client', 'prime', '', undefined]) {
    assert.equal(spendLineFor(bucket, { viewer: preset === undefined ? null : { preset }, pack: campus, fold }), '', `${preset}: nothing`)
    assert.equal(showSpend({ preset }, campus), false)
  }
  assert.equal(spendLineFor(bucket, { viewer: { preset: 'owner' }, pack: neutral, fold }), '', 'neutral: nothing')
  assert.equal(spendLineFor(bucket, { viewer: { preset: 'owner' }, pack: { ...campus, spend: undefined }, fold }), '', 'no spend key: nothing')
  assert.equal(spendLineFor(bucket, { viewer: { preset: 'owner' }, pack: { ...campus, spend: { show: true, currency: 'OMR' } }, fold }), 'Tokens 1.1k · 0.019 OMR · 30d', 'OMR through the response peg')
})

test('U35: no "actor" on the spend path — overlay/spend.mjs, compass/spend.mjs, the sidecar (its /spend route included), the schema and the captured response', () => {
  for (const f of ['overlay/spend.mjs', 'server/harnesses/compass/spend.mjs', 'server/harnesses/compass/overlay-api.mjs', 'server/harnesses/compass/pack-rules.mjs', 'spec/world-spend.v1.json', 'test/fixtures/m2b-spend.live.json']) {
    assert.ok(!/actor/i.test(fs.readFileSync(path.join(root, f), 'utf8')), `${f} names a person-shaped field`)
  }
  const api = fs.readFileSync(path.join(root, 'server/harnesses/compass/overlay-api.mjs'), 'utf8')
  assert.match(api, /url\.pathname === '\/spend'/, 'the sidecar serves /spend')
})

test('U35: the hook sums a transcript — deduplicated on message.id (last entry wins), the last model seen, source transcript; a missing transcript yields nothing', () => {
  const hook = path.join(root, '.claude/hooks/ledger.sh')
  const out = execFileSync('bash', [hook, 'usage', path.join(root, 'test/fixtures/m2b-transcript.jsonl')], { encoding: 'utf8' }).trim()
  // the six keys as U35 built them; since 2026-10-05 (aligned with the template) two models doing work add by_model
  assert.deepEqual(JSON.parse(out), { input_tokens: 102, output_tokens: 277, cache_creation_input_tokens: 42289, cache_read_input_tokens: 41090, model: 'claude-sonnet-5', source: 'transcript', by_model: { 'claude-fable-5-1': { input_tokens: 2, output_tokens: 247, cache_creation_input_tokens: 42239, cache_read_input_tokens: 39090 }, 'claude-sonnet-5': { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000 } } })
  assert.equal(execFileSync('bash', [hook, 'usage', path.join(root, 'test/fixtures/no-such-transcript.jsonl')], { encoding: 'utf8' }).trim(), '')
  assert.equal(execFileSync('bash', [hook, 'usage'], { encoding: 'utf8' }).trim(), '')
  assert.ok(Buffer.byteLength(out) < 8 * 1024)
  for (const k of ['content', 'text', 'transcript', 'body', 'stdout', 'stderr', 'diff', 'patch', 'email']) assert.ok(!(k in JSON.parse(out)), `no refused key ${k}`)
})

test('U35: SessionEnd posts run_completed with usage (dry run), without usage when there is no transcript, and the reconcile at the next SessionStart reads the closed session\'s transcript from the projects dir', () => {
  const hook = path.join(root, '.claude/hooks/ledger.sh')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-hook-'))
  const env = { ...process.env, HOOK_DRY_RUN: '1', LEDGER_STATE_DIR: path.join(tmp, 'state'), LEDGER_RUN_ID_FILE: path.join(tmp, 'run_id'), LEDGER_PROJECTS_DIR: path.join(tmp, 'projects'), LEDGER_STALE_MINUTES: '30' }
  const run = (event, input) => execFileSync('bash', [hook, event], { encoding: 'utf8', env, input: JSON.stringify(input) }).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const transcript = path.join(root, 'test/fixtures/m2b-transcript.jsonl')
  // a session with a transcript
  const s1 = 'zztest-hook-s1'
  assert.equal(run('run_started', { session_id: s1, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz' })[0].event_type, 'run_started')
  const ended = run('run_completed', { session_id: s1, hook_event_name: 'SessionEnd', transcript_path: transcript })
  const done = ended.find((e) => e.event_type === 'run_completed')
  assert.equal(done.payload.outcome, 'success')
  assert.deepEqual(done.payload.usage, { input_tokens: 102, output_tokens: 277, cache_creation_input_tokens: 42289, cache_read_input_tokens: 41090, model: 'claude-sonnet-5', source: 'transcript', by_model: { 'claude-fable-5-1': { input_tokens: 2, output_tokens: 247, cache_creation_input_tokens: 42239, cache_read_input_tokens: 39090 }, 'claude-sonnet-5': { input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 50, cache_read_input_tokens: 2000 } } })
  assert.ok(!fs.existsSync(path.join(tmp, 'state', `${s1}.session`)), 'the state file is gone')
  // a session without one: run_completed, no usage key, exit 0
  const s2 = 'zztest-hook-s2'
  run('run_started', { session_id: s2, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz' })
  const done2 = run('run_completed', { session_id: s2, hook_event_name: 'SessionEnd', transcript_path: path.join(tmp, 'missing.jsonl') }).find((e) => e.event_type === 'run_completed')
  assert.deepEqual(done2.payload, { outcome: 'success' })
  // the reconcile path: a stale session whose transcript sits at <projects>/<slug of cwd>/<id>.jsonl
  const s3 = 'zztest-hook-s3'
  run('run_started', { session_id: s3, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz.cwd' })
  const slugDir = path.join(tmp, 'projects', '-tmp-zz-cwd')
  fs.mkdirSync(slugDir, { recursive: true })
  fs.copyFileSync(transcript, path.join(slugDir, `${s3}.jsonl`))
  const old = new Date(Date.now() - 45 * 60_000)
  for (const f of [`${s3}.session`, `${s3}.gates`]) fs.utimesSync(path.join(tmp, 'state', f), old, old)
  const rec = run('session_start', { session_id: 'zztest-hook-s4', hook_event_name: 'SessionStart', cwd: '/tmp/zz' }).find((e) => e.event_type === 'run_completed' && e.run_id === s3)
  assert.ok(rec, 'the stale session was reconciled')
  assert.equal(rec.payload.note, 'reconciled_at_next_session_start')
  assert.equal(rec.payload.usage?.model, 'claude-sonnet-5')
  assert.equal(rec.payload.usage?.cache_read_input_tokens, 41090)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('U35: the sidecar serves GET /spend and /spend?window=n&include_test=1 from the reader, 404 without it', async () => {
  const http = await import('node:http')
  const { createOverlayApi, startOverlayApi } = await import(path.join(root, 'server/harnesses/compass/overlay-api.mjs'))
  const world = { planets: [{ key: 'zz', home: true }], towns: [], campus: { name: 'ZZ' } }
  const spend = { read: async ({ window, includeTest } = {}) => ({ at: 'x', window_days: window === undefined ? 30 : Number(window), includeTest: Boolean(includeTest), by_client: [] }) }
  const api = await startOverlayApi(createOverlayApi({ getWorld: async () => world, descriptor: async () => world, viewerFor: () => ({ preset: 'owner' }), spend }), { port: 0 })
  const get = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: api.port, path: p }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') })) }).on('error', reject))
  assert.deepEqual((await get('/spend')).body, { at: 'x', window_days: 30, includeTest: false, by_client: [] })
  assert.deepEqual((await get('/spend?window=7&include_test=1')).body, { at: 'x', window_days: 7, includeTest: true, by_client: [] })
  await api.close()
  const bare = await startOverlayApi(createOverlayApi({ getWorld: async () => world, descriptor: async () => world, viewerFor: () => ({ preset: 'owner' }) }), { port: 0 })
  const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: bare.port, path: '/spend' }, (res) => resolve(res.statusCode)).on('error', reject))
  assert.equal(status, 404)
  await bare.close()
})

test('U35: the reader — one Worker read per window per minute, the contract keys only, last good on failure, the error named when nothing was ever read', async () => {
  const { createSpend, normalise, windowParam } = await import(path.join(root, 'server/harnesses/compass/spend.mjs'))
  const { loadConfig } = await import(path.join(root, 'server/harnesses/compass/config.mjs'))
  const cfg = loadConfig({ EVENTS_URL: 'https://w.example/events', EVENTS_BEARER_TOKEN: 't' })
  assert.equal(cfg.spendUrl, 'https://w.example/world/spend')
  let clock = 1_000_000
  const calls = []
  let fail = false
  const fetchImpl = async (url, init) => {
    calls.push(url)
    assert.equal(init.headers.Authorization, 'Bearer t')
    if (fail) return { ok: false, status: 502, json: async () => ({ error: 'ops_skill_runs' }) }
    return { ok: true, status: 200, json: async () => ({ ...live, stray: 'not in the contract' }) }
  }
  const spend = createSpend(cfg, { fetchImpl, now: () => clock })
  const first = await spend.read()
  assert.equal(first.window_days, 30); assert.ok(!('stray' in first)); assert.equal(first.error, '')
  await spend.read(); await spend.read({ window: 30 })
  assert.equal(calls.length, 1, 'cached for a minute')
  await spend.read({ window: 7, includeTest: true })
  assert.equal(calls.at(-1), 'https://w.example/world/spend?window=7&include_test=1')
  clock += 61_000
  fail = true
  const kept = await spend.read()
  assert.equal(kept.by_client.length, live.by_client.length, 'the last good answer survives a failed read')
  const fresh = createSpend(cfg, { fetchImpl, now: () => clock })
  const none = await fresh.read()
  assert.deepEqual(none.by_client, []); assert.match(none.error, /spend read 502: ops_skill_runs/)
  assert.deepEqual([windowParam(7), windowParam('all'), windowParam('x'), windowParam(0), windowParam(400)], [7, 'all', 30, 30, 30])
  assert.equal(normalise(null).by_skill.length, 0)
})

// ── U36: the empty town and the estimate line ─────────────────────────────────────────────────

/** The test fixture only — SPEND_ESTIMATES holds no ZZTEST entry: a by_client row for the ZZTEST town with an est. */
const ZZ_EST = Object.freeze({ tokens_in_est: 1_000_000, tokens_out_est: 100_000, cost_usd_est: 12.0, conversations: 7, turns: 120, period_start: '2026-08-09', period_end: '2026-09-08', confidence: 'high' })
const zzRow = (over = {}) => b({ client: 'ZZTEST Client', runs_total: 2, runs_metered: 2, tokens_in: 315_000, tokens_out: 12_000, cost_usd: 0.6125, methods: { breakdown: 1, flat: 1 }, est: { ...ZZ_EST }, ...over })
const body = (rows, totals = {}) => ({ at: 'x', window_days: 30, estimates_version: 'test', display: null, totals: b({ ...totals }), by_client: rows, by_skill: [], by_client_skill: [], by_model: [] })
const owner = { preset: 'owner' }

test('U36: the empty town — a town with no by_client row, or one with runs_total 0 and no est, reads one quiet line `no runs · 30d`: never blank, never $0', async () => {
  const { foldSpend, townLines, reconcile } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const pack = loadPack('tellefsen-campus')
  const towns = [{ name: 'ZZTEST Client', planet: 'home' }, { name: 'Nothing Yet AS', planet: 'home' }, { name: 'Elsewhere Ltd', planet: 'other' }]
  const fold = foldSpend(body([zzRow({ est: undefined }), b({ client: 'Zero Runs AS', runs_total: 0 })], { runs_total: 2, runs_metered: 2, tokens_in: 315_000, tokens_out: 12_000, cost_usd: 0.6125 }), { pack, towns: [...towns, { name: 'Zero Runs AS', planet: 'home' }], planet: 'home', home: 'home' })
  assert.deepEqual([...fold.towns.keys()].sort(), ['Nothing Yet AS', 'ZZTEST Client', 'Zero Runs AS'], 'every town of this planet has a bucket, rows or not; the other planet\'s does not')
  assert.equal(fold.towns.get('Nothing Yet AS').runs_total, 0); assert.ok(!('est' in fold.towns.get('Nothing Yet AS')), 'no row → no est key')
  assert.deepEqual(reconcile(fold), { roomsPlusElsewhereIsCampus: true, townsPlusCampusIsPlanet: true }, 'an empty bucket is no term')
  const opts = { viewer: owner, pack, fold }
  assert.deepEqual(townLines(fold.towns.get('Nothing Yet AS'), opts), ['no runs · 30d'], 'no row')
  assert.deepEqual(townLines(fold.towns.get('Zero Runs AS'), opts), ['no runs · 30d'], 'a row with runs_total 0 and no est')
  assert.deepEqual(townLines(undefined, opts), ['no runs · 30d'], 'no bucket at all')
  for (const lines of [townLines(fold.towns.get('Nothing Yet AS'), opts), townLines(undefined, opts)]) {
    assert.ok(lines.length === 1 && lines[0].length > 0, 'one line, never blank')
    assert.ok(!/\$0|\$ 0|Tokens 0/.test(lines.join(' ')), 'never $0')
  }
  assert.deepEqual(townLines(fold.towns.get('ZZTEST Client'), opts), ['Tokens 327k · $0.61 · 30d'], 'a town with runs and no est: the metered line alone, as U35 left it')
  assert.deepEqual(townLines(fold.towns.get('ZZTEST Client'), { viewer: { preset: 'operator' }, pack, fold }), [], 'not the Owner: nothing, not a quiet line')
  assert.deepEqual(townLines(undefined, { viewer: owner, pack: loadPack('neutral'), fold }), [], 'neutral: nothing')
})

test('U36: the estimate line — `est. chat {in+out} · ~{cost} · {start}–{end} · {n} conversations`, compact numbers, the tilde and the word est. mandatory; confidence medium adds `· attributed by name`; totals.est (no period, no conversations) reads its two segments', async () => {
  const { estLine } = await import(path.join(root, 'overlay/spend.mjs'))
  const high = estLine(ZZ_EST)
  assert.equal(high, 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 7 conversations')
  assert.ok(high.startsWith('est. ') && high.includes(' ~$'), 'est. and the tilde')
  assert.equal(estLine({ ...ZZ_EST, confidence: 'medium' }), 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 7 conversations · attributed by name')
  assert.equal(estLine({ ...ZZ_EST, confidence: 'low' }), high, 'only medium carries the suffix')
  assert.equal(estLine({ ...ZZ_EST, conversations: 1 }), 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 1 conversation')
  assert.equal(estLine({ tokens_in_est: 246_972_478, tokens_out_est: 698_741, cost_usd_est: 245.35, conversations: 28, period_start: '2026-08-09', period_end: '2026-09-08', confidence: 'medium' }), 'est. chat 248M · ~$245.35 · 2026-08-09–2026-09-08 · 28 conversations · attributed by name', 'Peopleinsport, live 2026-09-08')
  assert.equal(estLine({ tokens_in_est: 1_487_587_191, tokens_out_est: 4_874_341, cost_usd_est: 1388.62, clients: 9 }), 'est. chat 1.5B · ~$1388.62', 'totals.est: two segments, the compact tier for billions')
  assert.equal(estLine(ZZ_EST, { currency: 'OMR', omrPerUsd: 0.3845 }), 'est. chat 1.1M · ~4.614 OMR · 2026-08-09–2026-09-08 · 7 conversations', 'OMR through the response peg, the tilde kept')
  assert.equal(estLine(null), ''); assert.equal(estLine('x'), '')
})

test('U36: no summing — the metered line is byte-identical with and without est; the fold\'s counters, the campus, the planet and both identities are unchanged by an est; the campus and the planet carry totals.est on their own line', async () => {
  const { foldSpend, spendLine, townLines, estLineFor, reconcile, COUNTERS, add, bucket } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const pack = loadPack('tellefsen-campus')
  const towns = [{ name: 'ZZTEST Client', planet: 'home' }]
  const totals = { runs_total: 2, runs_metered: 2, tokens_in: 315_000, tokens_out: 12_000, cost_usd: 0.6125 }
  const withEst = foldSpend(body([zzRow()], { ...totals, est: { tokens_in_est: 1_000_000, tokens_out_est: 100_000, cost_usd_est: 12.0, clients: 1 } }), { pack, towns, planet: 'home', home: 'home' })
  const without = foldSpend(body([zzRow({ est: undefined })], totals), { pack, towns, planet: 'home', home: 'home' })
  assert.ok(!COUNTERS.some((k) => /est/.test(k)), 'no est counter')
  const t1 = withEst.towns.get('ZZTEST Client'); const t0 = without.towns.get('ZZTEST Client')
  assert.deepEqual(Object.fromEntries(COUNTERS.map((k) => [k, t1[k]])), Object.fromEntries(COUNTERS.map((k) => [k, t0[k]])), 'the town\'s counters')
  assert.equal(spendLine(t1, { window: 30 }), spendLine(t0, { window: 30 }), 'the metered line, byte for byte')
  assert.equal(spendLine(t1, { window: 30 }), 'Tokens 327k · $0.61 · 30d', 'Iota\'s line, not a dollar more')
  for (const k of ['campus', 'planet', 'elsewhere']) assert.deepEqual(Object.fromEntries(COUNTERS.map((c) => [c, withEst[k][c]])), Object.fromEntries(COUNTERS.map((c) => [c, without[k][c]])), k)
  assert.deepEqual(reconcile(withEst), { roomsPlusElsewhereIsCampus: true, townsPlusCampusIsPlanet: true })
  assert.equal(add(bucket(), t1).cost_usd, 0.6125, 'add() never reads est'); assert.ok(!('est' in add(bucket(), t1)))
  const opts = { viewer: owner, pack, fold: withEst }
  assert.deepEqual(townLines(t1, opts), ['Tokens 327k · $0.61 · 30d', 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 7 conversations'], 'the town card: the metered line, then the estimate')
  assert.deepEqual(townLines(zzRow({ runs_total: 0, runs_metered: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }), opts), ['no metered runs · 30d', 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 7 conversations'], 'runs_total 0 with an est: `no metered runs`, then the estimate')
  assert.equal(estLineFor(withEst.campus, opts), 'est. chat 1.1M · ~$12.00', 'the campus: totals.est')
  assert.equal(estLineFor(withEst.planet, opts), 'est. chat 1.1M · ~$12.00', 'the planet: totals.est')
  assert.equal(estLineFor(without.campus, opts), '', 'no totals.est → no line'); assert.ok(!('est' in without.planet))
  const zero = foldSpend(body([zzRow({ est: undefined })], { ...totals, est: { tokens_in_est: 0, tokens_out_est: 0, cost_usd_est: 0, clients: 0 } }), { pack, towns, planet: 'home', home: 'home' })
  assert.ok(!('est' in zero.campus) && !('est' in zero.planet), 'a zero totals.est is no line')
  assert.equal(estLineFor(withEst.rooms.get('workshop'), opts), '', 'room panels unchanged: a room bucket carries no est')
})

test('U36: the pack flag — spend.estimates true on tellefsen-campus shows the estimate line; a pack without it (or neutral, or any other preset) hides the line and the town reads `no runs`, not `no metered runs`', async () => {
  const { foldSpend, townLines, estLineFor, showEstimates } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const campus = loadPack('tellefsen-campus'); const neutral = loadPack('neutral')
  const noFlag = { ...campus, spend: { show: true, window_days: 30, currency: 'USD' } }
  const off = { ...campus, spend: { ...campus.spend, estimates: false } }
  const towns = [{ name: 'ZZTEST Client', planet: 'home' }]
  const fold = foldSpend(body([zzRow()]), { pack: campus, towns, planet: 'home', home: 'home' })
  const t = fold.towns.get('ZZTEST Client')
  assert.equal(showEstimates(owner, campus), true)
  assert.equal(estLineFor(t, { viewer: owner, pack: campus, fold }), 'est. chat 1.1M · ~$12.00 · 2026-08-09–2026-09-08 · 7 conversations')
  for (const [name, pack] of [['no flag', noFlag], ['estimates false', off], ['neutral', neutral]]) {
    assert.equal(showEstimates(owner, pack), false, name)
    assert.equal(estLineFor(t, { viewer: owner, pack, fold }), '', name)
  }
  assert.deepEqual(townLines(t, { viewer: owner, pack: noFlag, fold }), ['Tokens 327k · $0.61 · 30d'], 'the metered line stays')
  assert.deepEqual(townLines(zzRow({ runs_total: 0, runs_metered: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }), { viewer: owner, pack: noFlag, fold }), ['no runs · 30d'], 'an est the pack hides is an est the town does not have')
  for (const preset of ['operator', 'viewer', 'client', 'prime', '']) {
    assert.equal(estLineFor(t, { viewer: { preset }, pack: campus, fold }), '', preset)
    assert.equal(showEstimates({ preset }, campus), false)
  }
  assert.equal(estLineFor(t, { viewer: null, pack: campus, fold }), '')
})

test('U36: the live capture — estimates_version rides through the reader; Peopleinsport and Titan Containers read `no metered runs` and their estimate; no "actor" and no person-shaped key on any est', async () => {
  const { foldSpend, townLines, estLineFor, summary } = await import(path.join(root, 'overlay/spend.mjs'))
  const { normalise } = await import(path.join(root, 'server/harnesses/compass/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const pack = loadPack('tellefsen-campus')
  const n = normalise(live)
  assert.equal(n.estimates_version, live.estimates_version); assert.ok(n.estimates_version.length > 0)
  assert.equal(normalise({ ...live, estimates_version: undefined }).estimates_version, '', 'absent → no estimates')
  assert.deepEqual(n.by_client.find((r) => r.client === 'Titan Containers')?.est, live.by_client.find((r) => r.client === 'Titan Containers').est, 'est rides through untouched')
  const schemaKeys = Object.keys(read('spec/world-spend.v1.json').properties.by_client.items.properties.est.properties)
  for (const r of live.by_client.filter((r) => r.est)) {
    for (const k of Object.keys(r.est)) assert.ok(schemaKeys.includes(k), `${r.client}.est.${k} is in the contract`)
    assert.ok(!/actor|person|user|owner|name\b/i.test(Object.keys(r.est).join(' ')), 'no person-shaped key')
  }
  const towns = live.by_client.filter((r) => r.client !== 'internal').map((r) => ({ name: r.client, planet: 'tellefsen' }))
  const fold = foldSpend(n, { pack, towns, planet: 'tellefsen', home: 'tellefsen' })
  const opts = { viewer: owner, pack, fold }
  assert.equal(fold.estimatesVersion, live.estimates_version); assert.equal(summary(fold).estimatesVersion, live.estimates_version)
  for (const name of ['Peopleinsport', 'Titan Containers']) {
    const row = live.by_client.find((r) => r.client === name)
    const lines = townLines(fold.towns.get(name), opts)
    assert.equal(lines.length, 2, name)
    assert.equal(lines[0], `no metered runs · ${live.window_days}d`, `${name}: runs_total ${row.runs_total} at capture`)
    assert.match(lines[1], /^est\. chat \S+ · ~\$[\d.]+ · \d{4}-\d{2}-\d{2}–\d{4}-\d{2}-\d{2} · \d+ conversations?( · attributed by name)?$/, name)
    assert.ok(lines[1].includes(`· ${row.est.conversations} conversation`), name)
    assert.equal(lines[1].endsWith('attributed by name'), row.est.confidence === 'medium', name)
  }
  assert.match(estLineFor(fold.planet, opts), /^est\. chat \S+ · ~\$[\d.]+$/, 'the planet: totals.est, two segments')
  assert.equal(estLineFor(fold.campus, opts), estLineFor(fold.planet, opts), 'the campus: the same totals.est')
  assert.ok(!/actor/i.test(fs.readFileSync(path.join(root, 'overlay/spend.mjs'), 'utf8')))
})

// ── U37: today's cost per town (Compass U5's GET /ledger/cost?days=1) ──────────────────────────

const TODAY = Object.freeze({
  at: '2026-10-04T09:00:00.000Z', days: 1, since: '2026-10-04T00:00:00.000Z', pricing_version: 'test', town_source: 'client', excluded_test_runs: 0,
  totals: b({ runs_total: 3, runs_metered: 2, cost_usd: 1.25 }),
  by_town: [b({ town: 'ZZTEST Client', runs_total: 3, runs_metered: 2, runs_unmetered: 1, cost_usd: 1.25 }), b({ town: 'ZZTEST Idle', runs_total: 1, runs_metered: 0, runs_unmetered: 1 })],
  by_town_day: [{ stray: 'not read' }],
})

test('U37: the today reader — GET /ledger/cost?days=1 with the bearer, cached, the error named on a 404 (not deployed yet) or a malformed answer, the last good kept', async () => {
  const { createSpend, normaliseToday } = await import(path.join(root, 'server/harnesses/compass/spend.mjs'))
  const { loadConfig } = await import(path.join(root, 'server/harnesses/compass/config.mjs'))
  const cfg = loadConfig({ EVENTS_URL: 'https://w.example/events', EVENTS_BEARER_TOKEN: 't' })
  assert.equal(cfg.ledgerCostUrl, 'https://w.example/ledger/cost')
  let clock = 1_000_000
  const calls = []
  let answer = () => ({ ok: true, status: 200, json: async () => TODAY })
  const fetchImpl = async (url, init) => (calls.push(url), assert.equal(init.headers.Authorization, 'Bearer t'), answer())
  const spend = createSpend(cfg, { fetchImpl, now: () => clock })
  const first = await spend.today()
  assert.equal(calls[0], 'https://w.example/ledger/cost?days=1')
  assert.equal(first.by_town.length, 2); assert.ok(!('by_town_day' in first)); assert.equal(first.error, '')
  await spend.today()
  assert.equal(calls.length, 1, 'cached for a minute')
  await spend.today({ includeTest: true })
  assert.equal(calls.at(-1), 'https://w.example/ledger/cost?days=1&include_test=1')
  clock += 61_000
  answer = () => ({ ok: false, status: 502, json: async () => ({ error: 'supabase read failed' }) })
  assert.equal((await spend.today()).by_town.length, 2, 'the last good answer survives a failed read')

  answer = () => ({ ok: false, status: 404, json: async () => ({ error: 'Not found' }) })
  const notYet = await createSpend(cfg, { fetchImpl, now: () => clock }).today()
  assert.deepEqual(notYet.by_town, []); assert.match(notYet.error, /today's cost read 404: Not found/)
  answer = () => ({ ok: true, status: 200, json: async () => [] })
  assert.match((await createSpend(cfg, { fetchImpl, now: () => clock }).today()).error, /not the shape the contract names/)
  assert.deepEqual(normaliseToday({ by_town: [{ town: '' }, { town: 'A', cost_usd: 1 }, 'x'] }).by_town, [{ town: 'A', cost_usd: 1 }])
})

test('U37: the sidecar serves GET /spend/today from the reader, 404 without it', async () => {
  const http = await import('node:http')
  const { createOverlayApi, startOverlayApi } = await import(path.join(root, 'server/harnesses/compass/overlay-api.mjs'))
  const world = { planets: [{ key: 'zz', home: true }], towns: [], campus: { name: 'ZZ' } }
  const get = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s || '{}') })) }).on('error', reject))
  const spend = { read: async () => ({}), today: async ({ includeTest } = {}) => ({ at: 'x', includeTest: Boolean(includeTest), by_town: [] }) }
  const api = await startOverlayApi(createOverlayApi({ getWorld: async () => world, descriptor: async () => world, viewerFor: () => ({ preset: 'owner' }), spend }), { port: 0 })
  assert.deepEqual((await get(api.port, '/spend/today')).body, { at: 'x', includeTest: false, by_town: [] })
  assert.deepEqual((await get(api.port, '/spend/today?include_test=1')).body, { at: 'x', includeTest: true, by_town: [] })
  await api.close()
  const old = await startOverlayApi(createOverlayApi({ getWorld: async () => world, descriptor: async () => world, viewerFor: () => ({ preset: 'owner' }), spend: { read: async () => ({}) } }), { port: 0 })
  assert.equal((await get(old.port, '/spend/today')).status, 404)
  await old.close()
})

test('U37: a town card reads today\'s line — cost and runs, unmetered and none said plainly, unavailable when the read failed, Owner-only, never per person', async () => {
  const { todayLine, todayLineFor, todayRowFor } = await import(path.join(root, 'overlay/spend.mjs'))
  const { loadPack } = await import(path.join(root, 'server/harnesses/compass/pack.mjs'))
  const campus = loadPack('tellefsen-campus'); const neutral = loadPack('neutral')
  const opts = { viewer: owner, pack: campus, fold: null, now: Date.parse('2026-10-04T09:30:00Z') }
  assert.equal(todayLineFor(TODAY, 'ZZTEST Client', opts), 'Today · $1.25 · 3 runs · 1 unmetered')
  assert.equal(todayLineFor(TODAY, 'ZZTEST Idle', opts), 'Today · unmetered · 1 run')
  assert.equal(todayLineFor(TODAY, 'ZZTEST Nowhere', opts), 'Today · no runs')
  assert.equal(todayLineFor({ ...TODAY, by_town: [], error: "today's cost read 404" }, 'ZZTEST Client', opts), 'Today · unavailable')
  assert.equal(todayLineFor(null, 'ZZTEST Client', opts), '', 'nothing read yet: no line')
  for (const viewer of [{ preset: 'operator' }, { preset: 'client' }, null]) assert.equal(todayLineFor(TODAY, 'ZZTEST Client', { ...opts, viewer }), '')
  assert.equal(todayLineFor(TODAY, 'ZZTEST Client', { ...opts, pack: neutral }), '')
  assert.equal(todayLine(todayRowFor(TODAY, 'ZZTEST Client'), { currency: 'OMR', omrPerUsd: 0.3845 }), 'Today · 0.481 OMR · 3 runs · 1 unmetered')
  // An unpriced run (a model MODEL_PRICING does not name) is said on the line, as the 30-day line says it: never silently short.
  assert.equal(todayLine(b({ town: 'X', runs_total: 3, runs_metered: 3, runs_unpriced: 1, cost_usd: 0.21 })), 'Today · $0.21 · 3 runs · 1 unpriced')
  // A kept answer from an earlier UTC day is not today's cost.
  assert.equal(todayLineFor(TODAY, 'ZZTEST Client', { ...opts, now: Date.parse('2026-10-05T09:30:00Z') }), 'Today · unavailable')
  for (const f of ['overlay/spend.mjs', 'server/harnesses/compass/spend.mjs', 'overlay/zones.mjs']) {
    assert.ok(!/actor/i.test(fs.readFileSync(path.join(root, f), 'utf8')), `${f} names a person-shaped field`)
  }
})
