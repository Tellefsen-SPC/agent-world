/**
 * Compass harness — the one file that knows Tellefsen's ontology.
 *
 * Reads the Run Ledger (through the Worker) and the surfaces, and emits Bot Crossing threads. Since M2b
 * (the still map, SPEC.md §3 O6) a thread is a fixture (an Active Notion Project, a room board) or a
 * request (an open ? or !): running, completed and sleeping runs produce none — a live run is a count on
 * its project fixture. Read only: the world is a mirror. Contract: server/harnesses/README.md.
 */
import { loadConfig } from './compass/config.mjs'
import { createLedgerClient } from './compass/supabase.mjs'
import { fold } from './compass/fold.mjs'
import { toThread } from './compass/threads.mjs'
import { buildStill } from './compass/still.mjs'
import { loadPack, roomsOf, lodOf } from './compass/pack.mjs'
import { generateLayout } from './compass/layout.mjs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_DATA_DIR, emptyState } from './compass/overlay-api.mjs'
import { trustOf, staleSkills, ranSkillsOf, campusAlert, projectsByClient, STALE_DAYS } from './compass/signals.mjs'
import { makeViewer } from './compass/viewer.mjs'
import { createSurfaces } from './compass/surfaces.mjs'
import { createSubstrate } from './compass/substrate.mjs'
import { createSpend } from './compass/spend.mjs'
import { deriveWorld, worldDescriptor } from './compass/zones.mjs'
import { createOverlayApi, startOverlayApi } from './compass/overlay-api.mjs'
import { createSteering } from './compass/steering.mjs'
import { createRooms, wantedSkills } from './compass/rooms.mjs'
import { roomForSkill, roomName } from './compass/pack.mjs'
import { createArchive } from './compass/archive.mjs'
import { CAMPUS } from './compass/config.mjs'
import { createHealth } from './compass/health.mjs'

const cfg = loadConfig()
const log = cfg.debug ? (...a) => console.error('[world]', ...a) : () => {}
const viewer = makeViewer({ tenant: cfg.tenant, preset: cfg.viewerPreset })
const surfaces = createSurfaces(cfg, { log })
const substrate = createSubstrate(cfg, { log })
const spend = createSpend(cfg, { log }) // U35: GET /world/spend, 60-s cache per window, served raw by the sidecar's /spend
const steering = createSteering(cfg, { surfaces, substrate, log }) // U19: three panels, 5-min caches, served by the sidecar
/** What the last scan saw — the room panels (U31) and the archive (U32) read it, never the ledger again. */
let lastScan = null
const rooms = createRooms(cfg, { surfaces, substrate, steering, pack: () => homePack(), lastScan: () => lastScan, log })
const archive = createArchive(cfg, { surfaces, lastScan: () => lastScan, homeName: () => world?.planets.find((p) => p.home)?.name || CAMPUS, log })
let ledger = null
let world = null // the derived zone map from the last substrate read (U12)
let overlayApi = null
let scanCache = { at: 0, threads: [] }
let lastErrorAt = 0
/** U37: whether Compass is answering — served as signals.compass, drawn as a pill on the strip. */
const health = createHealth()
/** U17: which skills ran in the last 30 days — a second, wider scan, refreshed every 5 min. */
let ranCache = { at: 0, ran: null }
const RAN_MS = 5 * 60_000
/** U17: the world's signals from the last scan — the campus flag, town ✓s, residents — served with GET /world. */
let signals = { at: '', campus: { alert: [] }, towns: {}, residents: [], counts: { needYou: 0, blocked: 0, running: 0, shippedToday: 0 } }
/** The pack the home planet wears, read server-side for the rooms and the skill → room rule (M2b). */
const homePack = () => loadPack(world?.planets.find((p) => p.home)?.pack || '')

/** Planets, towns and the campus, derived from the substrate at scan time (U12). Never stored. */
async function currentWorld() {
  world = deriveWorld(await substrate.read(), { campus: CAMPUS, tenant: cfg.tenant })
  viewer.pack = world.planets.find((p) => p.home)?.pack || ''
  await ensureLayouts(world)
  return world
}

/**
 * U29 — the layout, generated once per planet per process from the pack and the planet's towns (compass/layout.mjs):
 * rooms on rings 0–2, ring 3 empty, towns on spoke cells from ring 4. Sticky: an existing plot never moves; a new
 * town takes the next free slot. data/colony*.json is the world's only write; the file's other fields are kept as
 * they are. A planet with no substrate has no towns and gets nothing. Never in tests (no overlay port → no sidecar,
 * and this only runs behind the same gate).
 */
const laidOut = new Set()
async function ensureLayouts(w) {
  if (!cfg.overlayPort || process.env.NODE_TEST_CONTEXT) return
  for (const planet of w.planets) {
    if (laidOut.has(planet.key) || !planet.hasSubstrate) continue
    laidOut.add(planet.key)
    const file = path.join(DEFAULT_DATA_DIR, planet.home ? 'colony.json' : `colony.${planet.key}.json`)
    try {
      let state
      try {
        state = JSON.parse(await fsp.readFile(file, 'utf8'))
      } catch (err) {
        if (err?.code === 'ENOENT') state = emptyState()
        else throw new Error(`${path.relative(process.cwd(), file)} is not readable JSON — left as it is (${err.message})`)
      }
      const towns = w.towns.filter((t) => t.planet === planet.key).map((t) => t.name)
      const out = generateLayout({ pack: loadPack(planet.pack), towns, existing: state.plots || {} })
      if (!out.changed) {
        log(`layout ${planet.key}: unchanged (${Object.keys(out.plots).length} plots)`)
        continue
      }
      const next = { ...state, plots: out.plots, updatedAt: Date.now() }
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file + '.tmp', JSON.stringify(next, null, 2))
      await fsp.rename(file + '.tmp', file)
      console.warn(`bot-crossing: compass — layout ${planet.key}: ${out.placed.length} town(s) placed [${out.placed.join(', ')}], ${out.kept.length} kept, ${out.dropped.length} dropped [${out.dropped.join(', ')}] → ${path.relative(process.cwd(), file)}`)
    } catch (err) {
      console.warn(`bot-crossing: compass — layout ${planet.key} not written —`, err?.message || err)
    }
  }
}

/** The overlay sidecar (overlay-api.mjs), started once the harness is detected; never in tests. */
function ensureOverlayApi() {
  if (overlayApi || !cfg.overlayPort) return
  const handle = createOverlayApi({
    getWorld: async () => world || currentWorld(),
    // Awaited: a page that loads right after a restart must not see a town-less world (seen 2026-09-07 — "plot" for a town).
    steering: () => steering.all(),
    rooms, // U31: GET /rooms, GET /rooms/<id>
    archive, // U32: GET /archive
    spend, // U35: GET /spend — the Worker's spend object; the overlay folds it through the pack (overlay/spend.mjs)
    // U20: the prospect rows ride with the world (one Airtable GET a minute); the overlay decides who stands and how faded.
    descriptor: async () => {
      const w = world || (await currentWorld().catch(() => deriveWorld(null, { campus: CAMPUS, tenant: cfg.tenant })))
      const pack = homePack()
      // M2b: the rooms (zone names the room plots carry) and the lod thresholds ride with the world; prospects are rows for the strategy room, not plots.
      return { ...worldDescriptor(w, viewer), signals, rooms: roomsOf(pack), lod: lodOf(pack), packId: pack.id || '', prospects: await steering.prospectRows() }
    },
    log,
  })
  overlayApi = startOverlayApi(handle, { port: cfg.overlayPort, log })
}

/** Present on this machine = the Worker's ledger route is reachable in principle. Cheap; runs every poll. */
const detect = async () => {
  const on = Boolean(cfg.ledgerUrl && cfg.eventsBearerToken)
  if (on) ensureOverlayApi()
  return on
}
// U29: the sidecar is up from the moment the adapter loads, not from the first poll — the overlay's fetch seam holds the
// page's own state read until GET /world has answered (the layout is generated inside that answer), and the page's
// first poll comes after its state read; a sidecar that waited for the poll would never start. Never under npm test.
if (cfg.ledgerUrl && cfg.eventsBearerToken && cfg.overlayPort && !process.env.NODE_TEST_CONTEXT) ensureOverlayApi()

/**
 * The skills with any event in the last STALE_DAYS days (U17 hand-raise). The Worker takes 6–9 s per scan
 * (measured 2026-09-07), so this never sits on the poll's path: a stale set is refreshed in the background
 * and the poll uses the last good one — null until the first refresh lands (no hands yet, honestly).
 */
let ranRefreshing = null
function ranSkills(now) {
  if ((!ranCache.ran || now - ranCache.at >= RAN_MS) && !ranRefreshing) {
    ranRefreshing = ledger
      .scanSince(new Date(now - STALE_DAYS * 24 * 3600 * 1000).toISOString())
      .then(({ events }) => {
        ranCache = { at: now, ran: ranSkillsOf(events) }
        log(`30-day scan: ${ranCache.ran.size} skills ran`)
      })
      .catch((err) => {
        console.warn('bot-crossing: compass — 30-day scan unavailable —', err?.message || err)
        ranCache.at = now
      })
      .finally(() => (ranRefreshing = null))
  }
  return ranCache.ran
}

async function scan(now = Date.now()) {
  ledger ||= createLedgerClient(cfg, { log })
  const since = new Date(now - cfg.windowDays * 24 * 3600 * 1000).toISOString()
  const { events, rows } = await ledger.scanSince(since)
  const runs = fold(events)
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const substrateNow = await substrate.read()
  const { place, towns, campus } = await currentWorld()
  const policy = substrateNow.auto_run_policy
  const trust = (skill, runClass) => trustOf(skill, runClass, policy)

  // The M1 shape per run (gates cross-checked on their surfaces, the instruction text, Open, artifacts, trust) —
  // the still map (U28) reads these and emits a thread only for a run that is a request.
  const threadOf = new Map()
  for (const run of runs.values()) {
    threadOf.set(run.id, await toThread(run, rowById.get(run.id) || null, viewer, surfaces, now, { runningTtlMs: cfg.runningTtlMs, claudeProjectUrl: cfg.claudeProjectUrl, place, trustOf: trust }))
  }

  // U28 — the surfaces that make requests and fixtures: Active projects (5 min), Pending Approval rows and
  // pending Decisions (15 s, stale-while-revalidate), Content In Review and System Health when their ids are set.
  const [projects, paRows, decisions, contentRows, healthRows] = await Promise.all([
    surfaces.activeProjects(), surfaces.pendingApprovals(), surfaces.pendingDecisions(), surfaces.contentInReview(), surfaces.systemHealthOpen(),
  ])
  const skillTypes = new Map((substrateNow.skills || []).filter((s) => s && s.name).map((s) => [s.name, s.type || '']))
  const still = buildStill({ now, ttlMs: cfg.runningTtlMs, runs, threadOf, projects, paRows, decisions, contentRows, healthRows, pack: homePack(), place, skillTypes, viewer })
  const threads = still.threads
  for (const t of threads) if (t.kind === 'request' && t.trust?.mode === undefined) t.trust = trust(t.skill, '')

  // U17 — the silent skills (no run in 30 days): a list for the records office panel, never a figure (ES-6.8).
  const ran = ranSkills(now)
  const stale = ran ? staleSkills(substrateNow.skills, ran) : []

  // U31/U32 — what the panels and the archive read from this scan: the runs, the rows, the projects, the skill states.
  const live = new Set(), failed = new Set()
  for (const r of runs.values()) {
    const t = threadOf.get(r.id)
    if (r.started && r.terminal == null && now - r.lastAt < cfg.runningTtlMs && !(t?.gates || []).length) live.add(r.skill)
  }
  for (const a of campusAlert(runs, now)) failed.add(a.skill) // a run_failed in 24 h with no later completion of the skill (U17's rule)
  lastScan = { at: now, runs, rowById, threads, projects, silent: stale.map((s) => s.name), live, failed }

  // Signals served with GET /world: the strip's counts (U28), the campus alert list (the ! requests stand in the
  // records office; the list feeds its panel), a ✓ per town whose project shipped a milestone (the mark is on the fixture).
  const byClient = projectsByClient(runs)
  const townSignals = {}
  for (const town of towns) {
    const projects = [...(byClient.get(town.name) || [])]
    let check = false
    for (const p of projects) if (await surfaces.recentDone(p)) check = true
    if (projects.length) townSignals[town.name] = { check, projects }
  }
  // U33 (ES-6.8) — the hand-raise: a silent skill raises only when the pack wants it and an Active project's Tech Stack
  // names the value; it is a dusty row in its room and a tray line, never a figure. Served as signals.dusty.
  const wanted = wantedSkills(homePack(), projects)
  const dusty = stale.filter((s) => wanted.has(s.name)).map((s) => { const r = roomForSkill(homePack(), s.name, s.type); return { name: s.name, room: roomName(homePack(), r.room), roomId: r.room, wants: r.wants } })
  signals = { at: new Date(now).toISOString(), campus: { name: campus.name, alert: campusAlert(runs, now) }, towns: townSignals, residents: stale.map((s) => s.name), dusty, counts: still.counts }

  log(`scan: ${runs.size} runs → ${threads.length} threads (${threads.filter((t) => t.kind === 'fixture').length} fixtures, ${threads.filter((t) => t.kind === 'request').length} requests: ${still.counts.needYou} need you, ${still.counts.blocked} blocked; ${still.counts.running} running, ${stale.length} silent skills)`)
  return threads
}

/** The scan, cached so the browser's 15 s poll costs one query burst; the last good result survives a failed read. */
async function scanThreads() {
  const now = Date.now()
  if (now - scanCache.at < cfg.scanCacheMs) return scanCache.threads
  try {
    scanCache = { at: now, threads: await scan(now) }
    health.ok()
  } catch (err) {
    if (now - lastErrorAt > 60_000) {
      lastErrorAt = now
      console.warn('bot-crossing: compass —', err?.message || err)
    }
    // The last good threads stay on screen — and the page is told they are old (U37).
    health.fail(err)
    scanCache = { at: now, threads: scanCache.threads }
  }
  signals = { ...signals, compass: health.snapshot() }
  return scanCache.threads
}

/** Open lands on the surface to tap; ref.url was resolved at scan time (SPEC.md §4.4). */
function openThread(ref) {
  const url = ref && typeof ref.url === 'string' ? ref.url : ''
  if (/^https?:\/\//.test(url)) return { ok: true, url }
  return { ok: false, error: 'This run has no surface to open' }
}

const newSession = () => ({ ok: false, error: 'Runs start in Claude, Cowork or Claude Code — not from the world' })
const setArchived = async () => ({ ok: false, error: 'The world is a mirror; runs cannot be archived here' })

export default { id: 'compass', name: 'Compass', detect, scanThreads, openThread, newSession, setArchived }

/** Exposed for tests and the console — never for the browser. */
export const _internals = { scan, cfg, viewer, world: () => world, currentWorld, signals: () => signals, steering, health, invalidate: () => (scanCache = { at: 0, threads: scanCache.threads }) }
