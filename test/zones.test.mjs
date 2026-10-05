// Agent World — U12: zones derived from the substrate, the overlay sidecar, the packs, and the
// rule that no company or client name lives in overlay code or pack files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const substrate = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/substrate.zztest.json'), 'utf8'))

test('U12: planets from WORLD_COMPANIES, towns from Active ops_clients, packs read live, runs placed by client', async () => {
  const { deriveWorld, DEFAULT_PACK } = await import(path.join(root, 'server/harnesses/compass/zones.mjs'))
  const world = deriveWorld(substrate, { campus: 'ZZTEST HQ', tenant: 'zz' })

  // one planet per company with a usable key; the broken key is dropped, never thrown on
  assert.deepEqual(world.planets.map((p) => p.key), ['zz-home', 'zz-venture', 'zz-claimer'])
  assert.equal(world.home, 'zz-home')
  const [home, venture, claimer] = world.planets
  assert.equal(home.home, true)
  assert.equal(home.colonyFile, 'data/colony.json')
  assert.equal(venture.colonyFile, 'data/colony.zz-venture.json')
  // packs: named → named; absent → the default; substrate null → an empty planet
  assert.equal(home.pack, 'tellefsen-campus')
  assert.equal(venture.pack, 'neutral')
  assert.equal(claimer.pack, DEFAULT_PACK)
  assert.equal(venture.hasSubstrate, false)
  assert.equal(home.hasSubstrate, true)
  assert.ok(!('claims' in home), 'the descriptor carries no clients list')

  // towns: every Active row once, on the company whose clients list names it, else the home
  const towns = Object.fromEntries(world.towns.map((t) => [t.name, t]))
  assert.deepEqual(Object.keys(towns).sort(), ['ZZTEST Branded Client', 'ZZTEST Claimed Client', 'ZZTEST Client', 'ZZTEST Second Client'])
  assert.equal(towns['ZZTEST Client'].planet, 'zz-home')
  assert.equal(towns['ZZTEST Claimed Client'].planet, 'zz-claimer')
  assert.equal(towns['ZZTEST Claimed Client'].pack, DEFAULT_PACK, "a town wears its company's pack")
  assert.equal(towns['ZZTEST Branded Client'].pack, 'neutral', 'world_branding.pack wins when set')
  assert.equal(towns['ZZTEST Branded Client'].ownPack, true)

  // placement is by client and nothing else
  assert.deepEqual(world.place(null), { zone: 'ZZTEST HQ', planet: 'zz-home', pack: 'tellefsen-campus', town: false })
  assert.deepEqual(world.place('ZZTEST Claimed Client'), { zone: 'ZZTEST Claimed Client', planet: 'zz-claimer', pack: DEFAULT_PACK, town: true })
  assert.deepEqual(world.place('ZZTEST Unknown'), { zone: 'ZZTEST Unknown', planet: 'zz-home', pack: 'tellefsen-campus', town: false })
  assert.equal(world.campus.name, 'ZZTEST HQ')

  // a second ZZTEST client appears as a town with no code change; removing it removes the town
  const fewer = { ...substrate, clients: substrate.clients.filter((c) => c.name !== 'ZZTEST Second Client') }
  assert.ok(!deriveWorld(fewer, { campus: 'ZZTEST HQ' }).towns.some((t) => t.name === 'ZZTEST Second Client'))

  // no substrate at all → one home planet, no towns, nothing thrown
  const bare = deriveWorld(null, { campus: 'ZZTEST HQ', tenant: 'zz' })
  assert.equal(bare.planets.length, 1)
  assert.equal(bare.home, 'zz')
  assert.deepEqual(bare.towns, [])
})

test('U12: threads carry planet and pack from the placement, and the viewer carries the pack', async () => {
  const { deriveWorld } = await import(path.join(root, 'server/harnesses/compass/zones.mjs'))
  const { toThread } = await import(path.join(root, 'server/harnesses/compass/threads.mjs'))
  const { makeViewer } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))
  const world = deriveWorld(substrate, { campus: 'ZZTEST HQ' })
  const viewer = makeViewer({ preset: 'owner', pack: world.planets[0].pack })
  assert.equal(viewer.pack, 'tellefsen-campus')
  const surfaces = { progress: async () => 0.05, gateResolved: async () => false }
  const run = { id: 'r1', skill: 'zztest-builder', trigger: 'claude_code', client: 'ZZTEST Claimed Client', project: null, gates: [], terminal: null, artifacts: [], lastAt: 1, startedAt: 1 }
  const t = await toThread(run, null, viewer, surfaces, 2, { place: world.place })
  assert.equal(t.project, 'ZZTEST Claimed Client')
  assert.equal(t.planet, 'zz-claimer')
  assert.equal(t.pack, 'tellefsen-campus')
  const hq = await toThread({ ...run, client: null }, null, viewer, surfaces, 2, { place: world.place })
  assert.equal(hq.project, 'ZZTEST HQ')
  assert.equal(hq.planet, 'zz-home')
  // without a placement (older callers) the M1 shape is unchanged
  const old = await toThread({ ...run, client: null }, null, viewer, surfaces, 2, {})
  assert.equal(old.project, 'Tellefsen HQ')
  assert.equal(old.planet, '')
})

test('U12: the sidecar serves the world and one layout file per non-home planet, created on first read, loopback only', async () => {
  const { deriveWorld, worldDescriptor } = await import(path.join(root, 'server/harnesses/compass/zones.mjs'))
  const { createOverlayApi, startOverlayApi } = await import(path.join(root, 'server/harnesses/compass/overlay-api.mjs'))
  const { makeViewer } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-zones-'))
  const world = deriveWorld(substrate, { campus: 'ZZTEST HQ' })
  const viewer = makeViewer({ preset: 'owner', pack: 'tellefsen-campus' })
  const handle = createOverlayApi({ getWorld: async () => world, descriptor: () => worldDescriptor(world, viewer, 'now'), viewerFor: () => viewer, dataDir })
  const api = await startOverlayApi(handle, { port: 0 })
  assert.ok(api.port > 0, 'listens')
  const base = `http://127.0.0.1:${api.port}`
  const origin = 'http://localhost:5274'
  try {
    const w = await (await fetch(`${base}/world`)).json()
    assert.deepEqual(Object.keys(w), ['at', 'viewer', 'home', 'planets', 'towns', 'campus'])
    assert.deepEqual(w.viewer, { tenant: 'tellefsen', preset: 'owner', scope: 'campus', capabilities: ['view', 'tap', 'ratify', 'ask', 'layout', 'admin'], pack: 'tellefsen-campus' })
    assert.ok(!JSON.stringify(w).includes('Bearer'), 'no token in the descriptor')

    // first read creates the planet's own file, empty
    const file = path.join(dataDir, 'colony.zz-venture.json')
    assert.ok(!fs.existsSync(file))
    const s0 = await (await fetch(`${base}/planets/zz-venture/state`)).json()
    assert.deepEqual(s0.plots, {})
    assert.ok(fs.existsSync(file), 'created on first render')

    // the browser PUTs it whole, with its Origin; read back
    const put = await fetch(`${base}/planets/zz-venture/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ plots: { 'ZZTEST Town': [[0, 0]] }, archived: [], settings: { preset: 'balanced' }, junk: 1 }),
    })
    assert.equal(put.status, 200)
    const s1 = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(s1.plots, { 'ZZTEST Town': [[0, 0]] })
    assert.equal('junk' in s1, false, 'same whitelist as api.mjs')
    assert.ok(!fs.existsSync(path.join(dataDir, 'colony.json')), 'the home file is never touched here')

    // the home planet and unknown keys are refused; a PUT without a local Origin is refused; CORS preflight answers
    assert.equal((await fetch(`${base}/planets/zz-home/state`)).status, 404)
    assert.equal((await fetch(`${base}/planets/nope/state`)).status, 404)
    assert.equal((await fetch(`${base}/planets/../etc/state`)).status, 404)
    assert.equal((await fetch(`${base}/planets/zz-venture/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    assert.equal((await fetch(`${base}/planets/zz-venture/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403)
    const pre = await fetch(`${base}/planets/zz-venture/state`, { method: 'OPTIONS', headers: { Origin: origin } })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), origin)
    // a rebound host (fetch drops a custom Host header, so go through node:http)
    const rebound = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: api.port, path: '/world', headers: { Host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode) })
      req.on('error', reject)
      req.end()
    })
    assert.equal(rebound, 403)
  } finally {
    await api.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('U12: the substrate reader is a GET with the bearer, cached 60 s, last-good on failure, EMPTY before any read', async () => {
  const { createSubstrate, EMPTY } = await import(path.join(root, 'server/harnesses/compass/substrate.mjs'))
  const calls = []
  let fail = false
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method || 'GET', auth: init?.headers?.Authorization })
    if (fail) return { ok: false, status: 502, json: async () => ({ error: 'down' }) }
    return { ok: true, status: 200, json: async () => substrate }
  }
  let t = 0
  const sub = createSubstrate({ substrateUrl: 'https://w.example/world/substrate', eventsBearerToken: 'zz', substrateCacheMs: 60_000 }, { fetchImpl, now: () => t })
  const a = await sub.read()
  assert.equal(a.clients.length, 6)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].auth, 'Bearer zz')
  t = 30_000
  await sub.read()
  assert.equal(calls.length, 1, 'cached')
  t = 61_000
  fail = true
  const b = await sub.read()
  assert.equal(calls.length, 2)
  assert.equal(b.clients.length, 6, 'last good answer survives a failed read')
  const cold = createSubstrate({ substrateUrl: 'https://w.example/world/substrate', eventsBearerToken: 'zz', substrateCacheMs: 60_000 }, { fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(await cold.read(), EMPTY)
})

const PACK_DIR = path.join(root, 'overlay/packs')
const packs = fs.readdirSync(PACK_DIR).filter((d) => fs.existsSync(path.join(PACK_DIR, d, 'pack.json')))

test('U12: two packs ship, each declaring skin, rooms, names and layout; rooms mirror the same surfaces under every pack', () => {
  assert.deepEqual(packs.sort(), ['neutral', 'tellefsen-campus'])
  const loaded = Object.fromEntries(packs.map((d) => [d, JSON.parse(fs.readFileSync(path.join(PACK_DIR, d, 'pack.json'), 'utf8'))]))
  for (const [dir, p] of Object.entries(loaded)) {
    assert.equal(p.id, dir, 'id = folder')
    for (const k of ['skin', 'rooms', 'names', 'layout', 'default_room']) assert.ok(p[k], `${dir}: ${k}`)
    for (const k of ['palette', 'kit', 'lighting', 'sky', 'sounds', 'badges']) assert.ok(p.skin[k], `${dir}: skin.${k}`)
    for (const k of ['world', 'town', 'building', 'studio', 'agent']) assert.ok(typeof p.names[k] === 'string' && p.names[k], `${dir}: names.${k}`)
    assert.ok(p.rooms.length >= 1)
    for (const r of p.rooms) for (const k of ['id', 'name', 'mirrors', 'surface']) assert.ok(r[k], `${dir}: room ${r.id || '?'} ${k}`)
    assert.ok(p.rooms.some((r) => r.id === p.default_room), `${dir}: default_room exists`)
    assert.deepEqual(p.skin.badges, { waiting: '?', blocked: '!', working: '⚒', done: '✓', asleep: 'z' }, `${dir}: badge precedence is not a pack's to change`)
  }
  const campus = loaded['tellefsen-campus']
  // M2b (ES-6.4 / ES-6.6, 2026-09-07): the still map's ten rooms with ring positions; the Steering Room is retired
  assert.deepEqual(
    campus.rooms.map((r) => r.name),
    ['corner office', 'board room', 'strategy room', 'marketing studio', 'research lab', 'finance office', 'workshop', 'integration yard', 'archive', 'records office'],
    'the still map\'s rooms (ES-6.4)'
  )
  assert.deepEqual(campus.rooms.map((r) => `${r.ring}.${r.spoke}`), ['0.0', '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '2.0', '2.2', '2.4'], 'centre, six on ring 1, three alternating spokes on ring 2')
  assert.deepEqual(campus.names, { world: 'campus', planet: 'planet', centre: 'campus', town: 'town', building: 'building', studio: 'room', agent: 'agent', fixture: 'fixture', request: 'request', prospect: 'prospect' })
  for (const [dir, p] of Object.entries(loaded)) {
    assert.equal(p.figure, 'character', `${dir}: figure`)
    assert.ok(p.lod && p.lod.orbit > p.lod.desk, `${dir}: lod.orbit above lod.desk`)
    assert.ok(p.skills && p.skills.by_type && p.skills.overrides, `${dir}: skills rule`)
    assert.equal(p.skills.overrides['zztest-stale-expert']?.wants, 'Airtable', `${dir}: the standing test skill wants Airtable (V-U33)`)
  }
  assert.deepEqual(loaded.neutral.rooms.map((r) => `${r.id}:${r.ring}.${r.spoke}`), campus.rooms.map((r) => `${r.id}:${r.ring}.${r.spoke}`), 'neutral: the same geometry')
  // the same rooms mirror the same surfaces under both packs
  const surfaces = (p) => p.rooms.map((r) => `${r.id}:${r.surface}`)
  assert.deepEqual(surfaces(loaded.neutral), surfaces(campus))
  assert.ok(!/tellefsen/i.test(JSON.stringify(loaded.neutral)), 'neutral: no Tellefsen name anywhere')
})

/** Every file under overlay/ (code and packs) — the zone map is derived, never hardcoded. */
const overlayFiles = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) overlayFiles(p, out)
    else if (/\.(m?js|json|css|html)$/.test(name)) out.push(p)
  }
  return out
}

test('U12: no company or client name in overlay code or pack files (static names; live Compass names when the bearer is present)', async () => {
  const needles = [/tellefsen/i, /zztest/i]
  // The pack id `tellefsen-campus` is the substrate's own value for the default pack, not a name; strip it before matching.
  // Skill names are not client names: the packs' per-skill overrides (M2b) may name a skill, never a client or company.
  const scrub = (text) => text.replace(/tellefsen-campus/g, '').replace(/"(tellefsen-design|zztest-stale-expert)"\s*:/g, '"skill":')
  const names = []
  const url = (process.env.EVENTS_URL || '').replace(/\/+$/, '').replace(/\/events$/, '/world/substrate')
  if (url && process.env.EVENTS_BEARER_TOKEN) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.EVENTS_BEARER_TOKEN}` }, signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const live = await res.json()
        for (const c of live.clients || []) if (c?.name) names.push(c.name)
        for (const c of live.world_companies?.companies || []) if (c?.name) names.push(c.name)
      }
    } catch {
      /* offline: the static needles still run */
    }
  }
  const hits = []
  for (const f of overlayFiles(path.join(root, 'overlay'))) {
    const text = scrub(fs.readFileSync(f, 'utf8'))
    for (const n of needles) if (n.test(text)) hits.push(`${path.relative(root, f)} matches ${n}`)
    for (const name of names) if (name && text.toLowerCase().includes(name.toLowerCase())) hits.push(`${path.relative(root, f)} names "${name}"`)
  }
  assert.deepEqual(hits, [], `names found in overlay/:\n${hits.join('\n')}`)
})
