// overlay/zones.mjs — the world's shape, read live from the adapter's sidecar (U12).
//
// Bot Crossing's page fetches /api/threads and /api/state and knows one layout file. This module
// wraps window.fetch before src/main.js boots (index.html mounts the overlay first) so that:
//   - /api/threads only ever carries the planet on screen (a planet never shows another's runs);
//   - a non-home planet's /api/state goes to its own data/colony.<key>.json through the sidecar,
//     leaving data/colony.json to the API exactly as upstream wrote it.
// The planet on screen is this browser's choice (localStorage), like the hide list — never state
// on the server. No token ever reaches this file: the sidecar hands out names and packs only.
//   - residents (U17: skills silent 30 days, sent by the adapter as sleeping figures) never take a
//     figure slot from a run: they fill what is left under Bot Crossing's maxAgents, and go last.
import { benchResidents } from './signals.mjs'
import { nextTownSlot } from '../server/harnesses/compass/layout.mjs'
import { packFor } from './packs/index.mjs'

const PORT = Number(window.AW_OVERLAY_PORT) || 5275
export const SIDECAR = `${location.protocol}//${location.hostname}:${PORT}`
const STORE = 'aw.planet'

let world = null
let current = ''

const stored = () => {
  try {
    return localStorage.getItem(STORE) || ''
  } catch {
    return ''
  }
}

/** One read of the sidecar; a world that is not there (port off, sidecar down) means home only. */
async function loadWorld() {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 2500)
  try {
    const res = await fetch(`${SIDECAR}/world`, { signal: ctl.signal, headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`${res.status}`)
    world = await res.json()
    const want = stored()
    current = world.planets.some((p) => p.key === want) ? want : world.home
  } catch (err) {
    console.warn('[world] sidecar unavailable — home planet only:', err?.message || err)
    world = null
    current = ''
  } finally {
    clearTimeout(timer)
  }
  return world
}

/**
 * Resolves once the world is known — or, after a minute of asking, known to be unavailable; the fetch seam waits on it.
 * U29: the adapter lays the map (data/colony.json) inside its first world derivation, which the sidecar's GET /world
 * awaits — so the page's own /api/state read must come after that answer, or Bot Crossing boots on the file as it
 * was, keeps those cells in its layout memory and saves them back over the generated ones (found at the U29 review).
 * A page opening in the seconds after ./dev.sh starts therefore waits for the sidecar rather than passing through.
 */
export const ready = (async () => {
  const deadline = Date.now() + 60_000
  let got = await loadWorld()
  while (!got && Date.now() < deadline) {
    // a nudge: the API's harness detection starts the sidecar if the adapter has not (an older adapter, a slow boot)
    try { await fetch('/api/harnesses', { signal: AbortSignal.timeout(2000) }) } catch { /* the API itself is not up yet */ }
    await new Promise((r) => setTimeout(r, 2000))
    got = await loadWorld()
  }
  if (!got) console.warn('[world] no sidecar after a minute — home planet only, layout as the file has it')
  return got
})()

// A page that loads in the seconds after ./dev.sh starts finds the sidecar not listening yet (it starts on
// the adapter's first detect). Keep asking for a minute; the first answer lights up the switcher, the
// residents' bench and the planet filter — until then the seam passes everything through (home only).
ready.then((w) => {
  if (w) return
  let tries = 0
  const timer = setInterval(async () => {
    if (world || ++tries > 12) return clearInterval(timer)
    const got = await loadWorld()
    if (got) {
      clearInterval(timer)
      console.info('[world] sidecar reached after a retry — planets, towns and signals are live')
      for (const fn of lateListeners) fn(got)
    }
  }, 5000)
})
const lateListeners = new Set()
/** Called once if the world arrives late (the sidecar was not up when the page loaded). */
export const onWorldLate = (fn) => lateListeners.add(fn)

/** The signals (U17) change with every scan: re-read GET /world on the poll's own cadence, keeping the shape stable. */
const REFRESH_MS = 15_000
async function refreshWorld() {
  if (!world) return
  try {
    // ten seconds: a refresh may land while the adapter is mid-read of a slow substrate; the last good world holds meanwhile
    const res = await fetch(`${SIDECAR}/world`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return
    const next = await res.json()
    world.signals = next.signals || world.signals
    world.prospects = next.prospects || world.prospects
    world.towns = next.towns || world.towns
    world.at = next.at
  } catch {
    /* keep the last good world */
  }
}
ready.then(() => setInterval(refreshWorld, REFRESH_MS))
export const signals = () => world?.signals || { campus: { alert: [] }, towns: {}, residents: [] }
/** The Pipeline rows the prospect plots stand on (U20), as the sidecar last read them. */
export const prospectRows = () => world?.prospects || { rows: [], stages: [], error: '' }

/** One room's panel (U31) or the archive (U32), read from the sidecar; null when it is not there. Cached by the adapter, 5 min. */
export async function loadRoom(id) {
  try {
    const res = await fetch(`${SIDECAR}/rooms/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
export async function loadArchive() {
  try {
    const res = await fetch(`${SIDECAR}/archive`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
/**
 * The Worker's spend object (U35) as the sidecar last read it — 60-s cache there; null when the sidecar is not there.
 * includeTest keeps the test rows in (the page's ?include_test=1 — for the fixture check, never the default).
 */
export async function loadSpend(window = 30, includeTest = false) {
  try {
    const res = await fetch(`${SIDECAR}/spend?window=${encodeURIComponent(window)}${includeTest ? '&include_test=1' : ''}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
/** U37 — today's cost per town (the sidecar's /spend/today, from Compass's GET /ledger/cost?days=1); null when the sidecar is not there. */
export async function loadSpendToday(includeTest = false) {
  try {
    const res = await fetch(`${SIDECAR}/spend/today${includeTest ? '?include_test=1' : ''}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}
/**
 * U16 — the PA panel's one network call: the question to the sidecar's POST /ask, never to the Worker. The sidecar
 * adds the bearer (docs/adr/0008); nothing on this side holds one. Returns { status, body } for overlay/pa.mjs viewOf —
 * status 0 when the sidecar did not answer. Waits longer than the sidecar's own 40 s, so its 504 arrives first.
 */
export async function askPa(body) {
  try {
    const res = await fetch(`${SIDECAR}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    let json = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    return { status: res.status, body: json && typeof json === 'object' ? json : {} }
  } catch (err) {
    return { status: 0, body: { error: String(err?.message || err) } }
  }
}
/** The rooms the sidecar declares (the pack's, with ring and spoke) — the plots the room panels hang off. */
export const rooms = () => world?.rooms || []

/** The Steering Room's three panels (U19), read from the sidecar; null when it is not there. Cached by the adapter, 5 min. */
export async function loadSteering() {
  try {
    const res = await fetch(`${SIDECAR}/steering`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** How many residents stand on this planet's map, of how many the adapter sent (the rest are "on the bench"). */
let bench = { shown: 0, total: 0 }
export const residentsInfo = () => bench
/** Bot Crossing's figure cap — the page's own setting once it is up; its lowest preset until then. */
const maxAgents = () => Number(window.botCrossing?.settings?.get?.('maxAgents')) || 40

export const getWorld = () => world
export const currentKey = () => current
export const currentPlanet = () => world?.planets.find((p) => p.key === current) || null
export const isHome = () => !world || current === world.home
/** Towns on the planet on screen. */
export const townsHere = () => (world ? world.towns.filter((t) => t.planet === current) : [])

/** Pick a planet: remembered in this browser, then the page reloads onto that planet's layout file. */
export function switchTo(key) {
  if (!world || !world.planets.some((p) => p.key === key) || key === current) return
  try {
    localStorage.setItem(STORE, key)
  } catch {
    /* private mode: the switch lasts this load */
  }
  location.reload()
}

/**
 * U29: a zone the layout memory does not know yet — a town that gained its first request between restarts — would be
 * seeded by Bot Crossing at the innermost free cell (ring 3, beside the rooms). Before the roster reaches the page its
 * cells are written into the colony's layout memory on the next free spoke slot, the same slot the generator gives it
 * at the next restart. Rooms are the pack's and towns are the sidecar's; anything else (an unknown client) is left alone.
 */
function seatNewTowns(threads) {
  const colony = window.botCrossing?.colony
  if (!colony?.plotCells || !world) return
  const towns = new Set(world.towns.filter((t) => t.planet === current).map((t) => t.name))
  const pack = packFor(currentPlanet()?.pack || '')
  for (const t of threads) {
    const name = t?.project
    if (!name || !towns.has(name) || colony.plotCells.has(name)) continue
    const known = {}
    for (const [n, cells] of colony.plotCells) known[n] = cells.map((c) => [c.q, c.r])
    const slot = nextTownSlot(pack, known)
    if (!slot) continue
    colony.plotCells.set(name, [{ q: slot.q, r: slot.r }])
    console.info(`[world] new town ${name} seated on spoke cell (${slot.q}, ${slot.r})`)
  }
}

// ── the fetch seam ───────────────────────────────────────────────────────────────────────────

const realFetch = window.fetch.bind(window)
const urlOf = (input) => (typeof input === 'string' ? input : input instanceof Request ? input.url : String(input?.url || ''))
const pathOf = (u) => {
  try {
    return new URL(u, location.origin).pathname
  } catch {
    return ''
  }
}

window.fetch = async function awFetch(input, init) {
  const p = pathOf(urlOf(input))
  if (p !== '/api/threads' && p !== '/api/state') return realFetch(input, init)
  await ready
  if (!world) return realFetch(input, init)

  if (p === '/api/state' && current !== world.home) {
    // This planet's own layout file, created on first read by the sidecar. Same verb, same body.
    return realFetch(`${SIDECAR}/planets/${encodeURIComponent(current)}/state`, init)
  }
  if (p === '/api/threads') {
    const res = await realFetch(input, init)
    if (!res.ok) return res
    const body = await res.json().catch(() => ({}))
    const list = Array.isArray(body.threads) ? body.threads : []
    // Placed by the adapter; a thread with no planet (an older adapter) belongs to the home planet.
    const here = list.filter((t) => (t.planet || world.home) === current)
    seatNewTowns(here)
    const benched = benchResidents(here, maxAgents())
    bench = { shown: benched.shown, total: benched.total }
    body.threads = benched.threads
    return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
}
