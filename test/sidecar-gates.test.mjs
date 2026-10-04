// Agent World — the sidecar enforces what a viewer may have, so the overlay's own checks are no longer the only line
// (docs/multiplayer.md step 2; docs/adr/0005, 0006). Spend answers the Owner only; a layout write needs the `layout`
// capability. Loopback servers and fakes only — no Compass, no Notion, no Airtable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { createOverlayApi, startOverlayApi } = await import(path.join(root, 'server/harnesses/compass/overlay-api.mjs'))
const { makeViewer, PRESETS } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))

const world = { planets: [{ key: 'zz-home', home: true }, { key: 'zz-venture', home: false }], towns: [], campus: { name: 'ZZTEST HQ' } }
const origin = 'http://localhost:5274'

async function sidecar(viewerFor, { spend } = {}) {
  const reads = { spend: 0, today: 0 }
  const reader = spend || {
    read: async () => (reads.spend++, { at: 'x', window_days: 30, by_client: [{ client: 'ZZTEST Client', cost_usd: 1 }] }),
    today: async () => (reads.today++, { at: 'x', days: 1, by_town: [{ town: 'ZZTEST Client', cost_usd: 1 }] }),
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-gates-'))
  const opts = { getWorld: async () => world, descriptor: async () => world, spend: reader, dataDir }
  if (viewerFor !== undefined) opts.viewerFor = viewerFor
  const api = await startOverlayApi(createOverlayApi(opts), { port: 0 })
  const base = `http://127.0.0.1:${api.port}`
  return { api, base, reads, dataDir }
}

test('spend is Owner-only on the server: /spend and /spend/today answer 403 {error} for every other preset, and the reader is never asked', async () => {
  const owner = await sidecar(() => makeViewer({ preset: 'owner' }))
  try {
    const s = await fetch(`${owner.base}/spend`)
    assert.equal(s.status, 200)
    assert.equal((await s.json()).by_client.length, 1)
    assert.equal((await fetch(`${owner.base}/spend/today`)).status, 200)
    assert.deepEqual(owner.reads, { spend: 1, today: 1 })
  } finally {
    await owner.api.close()
  }

  for (const preset of Object.keys(PRESETS).filter((p) => p !== 'owner')) {
    const other = await sidecar(() => makeViewer({ preset }))
    try {
      for (const route of ['/spend', '/spend?window=7&include_test=1', '/spend/today', '/spend/today?include_test=1']) {
        const res = await fetch(`${other.base}${route}`)
        assert.equal(res.status, 403, `${preset} ${route}`)
        const body = await res.json()
        assert.deepEqual(Object.keys(body), ['error'], `${preset} ${route}: an error and nothing else`)
        assert.match(body.error, /Owner/)
        assert.ok(!JSON.stringify(body).includes('cost_usd'), 'no figure leaks in the refusal')
      }
      assert.deepEqual(other.reads, { spend: 0, today: 0 }, `${preset}: the Worker is never read for a refused viewer`)
    } finally {
      await other.api.close()
    }
  }
})

test('spend fails closed: a sidecar given no viewer, or one that resolves to none, serves no spend', async () => {
  for (const viewerFor of [undefined, () => null, () => ({ preset: 'Owner ' }), () => { throw new Error('no identity') }]) {
    const s = await sidecar(viewerFor)
    try {
      assert.equal((await fetch(`${s.base}/spend`)).status, 403)
      assert.equal((await fetch(`${s.base}/spend/today`)).status, 403)
      assert.deepEqual(s.reads, { spend: 0, today: 0 })
    } finally {
      await s.api.close()
    }
  }
})

test('a layout write needs the layout capability: PUT /planets/<key>/state is 403 {error} without it and the file is left as it was', async () => {
  const put = (base, plots) =>
    fetch(`${base}/planets/zz-venture/state`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ plots }) })

  const owner = await sidecar(() => makeViewer({ preset: 'owner' }))
  try {
    assert.equal((await put(owner.base, { 'ZZTEST Town': [[0, 0]] })).status, 200)
    const file = path.join(owner.dataDir, 'colony.zz-venture.json')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).plots, { 'ZZTEST Town': [[0, 0]] })
  } finally {
    await owner.api.close()
  }

  for (const preset of Object.keys(PRESETS).filter((p) => !PRESETS[p].capabilities.includes('layout'))) {
    const s = await sidecar(() => makeViewer({ preset }))
    try {
      const file = path.join(s.dataDir, 'colony.zz-venture.json')
      // reading the planet still works (and creates the empty file on first render, ES-4.2)
      const got = await fetch(`${s.base}/planets/zz-venture/state`)
      assert.equal(got.status, 200, `${preset} may read the layout`)
      const before = fs.readFileSync(file, 'utf8')
      const res = await put(s.base, { 'ZZTEST Town': [[9, 9]] })
      assert.equal(res.status, 403, `${preset} may not write the layout`)
      const body = await res.json()
      assert.deepEqual(Object.keys(body), ['error'])
      assert.match(body.error, /layout/)
      assert.equal(fs.readFileSync(file, 'utf8'), before, `${preset}: the layout file is unchanged`)
    } finally {
      await s.api.close()
    }
  }

  // no viewer at all: no write
  const bare = await sidecar(undefined)
  try {
    assert.equal((await put(bare.base, { x: [[1, 1]] })).status, 403)
    assert.ok(!fs.existsSync(path.join(bare.dataDir, 'colony.zz-venture.json')), 'nothing written')
  } finally {
    await bare.api.close()
  }
})

test('the viewer is asked per request, so M3 can hand each request its own identity without redesigning the sidecar', async () => {
  let preset = 'viewer'
  const seen = []
  const s = await sidecar((req) => (seen.push(req.url), makeViewer({ preset })))
  try {
    assert.equal((await fetch(`${s.base}/spend`)).status, 403)
    preset = 'owner'
    assert.equal((await fetch(`${s.base}/spend`)).status, 200)
    assert.deepEqual(seen, ['/spend', '/spend'], 'the request reaches viewerFor')
  } finally {
    await s.api.close()
  }
})
