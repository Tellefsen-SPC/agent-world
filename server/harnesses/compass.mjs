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
import { createAsk, personNames } from './compass/ask.mjs'
import { deriveWorld, worldDescriptor } from './compass/zones.mjs'
import { createOverlayApi, startOverlayApi } from './compass/overlay-api.mjs'
import { createSteering } from './compass/steering.mjs'
import { createRooms, wantedSkills } from './compass/rooms.mjs'
import { roomForSkill, roomName } from './compass/pack.mjs'
import { createArchive } from './compass/archive.mjs'
import { CAMPUS } from './compass/config.mjs'
import { createHealth } from './compass/health.mjs'
import { createStream } from './compass/stream.mjs'

const cfg = loadConfig()
const log = cfg.debug ? (...a) => console.error('[world]', ...a) : () => {}
const viewer = makeViewer({ tenant: cfg.tenant, preset: cfg.viewerPreset })
const surfaces = createSurfaces(cfg, { log })
const substrate = createSubstrate(cfg, { log })
const spend = createSpend(cfg, { log }) // U35: GET /world/spend, 60-s cache per window, served raw by the sidecar's /spend
/**
 * U16: the PA's question, forwarded to the Worker's POST /ask with the bearer — the browser never holds it (docs/adr/0008).
 * The backstop (review 5): an answer naming someone the last ledger scan names as an actor is withheld. The names are
 * the scan's, kept in memory with it; the page never holds one and nothing logs one.
 */
const ask = createAsk(cfg, {
  log,
  knownNames: () =>
    personNames(lastScan?.actors || [], {
      skills: [...(lastScan?.runs?.values?.() || [])].map((r) => r.skill),
      places: [...(world?.towns || []).map((t) => t.name), CAMPUS, ...(world?.planets || []).map((p) => p.name)],
    }),
})
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
    ask, // U16: POST /ask — the PA, Owner only (the `ask` capability), forwarded by compass/ask.mjs
    pagePort: cfg.pagePort, // the PA answers the world's own page only (host and port)
    // Who is asking: today the one viewer from WORLD_VIEWER_PRESET; at M3 the identity the hosted world's sign-in hands the request
    // (docs/adr/0006). The sidecar answers spend to the Owner only, takes a layout write only with `layout`, and a question only with `ask`.
    viewerFor: () => viewer,
    // U20: the prospect rows ride with the world (one Airtable GET a minute); the overlay decides who stands and how faded.
    descriptor: async () => {
      const w = world || (await currentWorld().catch(() => deriveWorld(null, { campus: CAMPUS, tenant: cfg.tenant })))
      const pack = homePack()
      // M2b: the rooms (zone names the room plots carry) and the lod thresholds ride with the world; prospects are rows for the strategy room, not plots.
      // U7: signals.stream says whether the nudge is on and what it did — never part of signals.compass (a stream down is not an outage)
      return { ...worldDescriptor(w, viewer), signals: { ...signals, stream: streamSignal() }, rooms: roomsOf(pack), lod: lodOf(pack), packId: pack.id || '', prospects: await steering.prospectRows() }
    },
    log,
  })
  overlayApi = startOverlayApi(handle, { port: cfg.overlayPort, log })
}

/**
 * U7 — the realtime nudge (ES-1.10), over the Worker's GET /events/stream (compass/stream.mjs). Each ledger event drops
 * the scan cache, so the next poll reads the ledger instead of a cached answer; an event that lands while a scan is in
 * flight marks that scan's answer stale too (runScan). The stream runs beside the polls and never in front of them: a
 * stream that is down, slow or switched off (WORLD_STREAM=0) leaves the world on its 5 s cache and 15 s poll, and is
 * not an outage. Started with the sidecar, never on its own under npm test (a test starts it through _internals).
 */
let stream = null
let nudgedAt = 0
/** What the nudge has done since start: events that dropped the cache, and scans that ran early because of one. */
let nudges = 0
let nudgedScans = 0
/** When the last scan finished — the cache's own clock, kept apart from scanCache.at, which a nudge zeroes. */
let scanFinishedAt = 0
/**
 * A scan that starts before this moment starts early: before the cache a nudge dropped would have run out on its own.
 * 0 when no nudge is waiting. Only such a scan is counted, so a poll that comes after natural expiry is never credited
 * to the nudge — and a nudge that dropped nothing can never raise the count (V-U7 rests on that).
 */
let earlyUntil = 0
function nudge(row) {
  nudges += 1
  nudgedAt = Date.now()
  // A fresh cache, dropped now, would have run out at its finish + scanCacheMs. An event during a scan sets its window
  // when that scan finishes (runScan).
  const expires = scanFinishedAt + cfg.scanCacheMs
  if (!scanning && scanCache.at && nudgedAt < expires) earlyUntil = Math.max(earlyUntil, expires)
  scanCache = { at: 0, threads: scanCache.threads }
  log(`realtime: ${row?.event_type || 'event'} on run ${String(row?.run_id || '?').slice(0, 8)} received — scan cache invalidated`)
}
function ensureStream({ inTest = false } = {}) {
  if (stream || (process.env.NODE_TEST_CONTEXT && !inTest)) return stream
  if (!cfg.streamEnabled || !cfg.streamUrl || !cfg.eventsBearerToken) return null
  // Vite re-imports the adapter in-process when a server file changes: end the previous instance's stream first.
  globalThis.__awStream?.stop?.()
  stream = createStream(cfg, { onEvent: nudge, log })
  globalThis.__awStream = stream
  stream.start()
  return stream
}
/**
 * signals.stream on GET /world: is the nudge connected, when did the last event arrive, how many events dropped the
 * cache (nudges) and how many scans ran early because of one (nudgedScans — zero with WORLD_STREAM=0). Counts and
 * times only: no token, no run, no person.
 */
function streamSignal() {
  const s = stream ? stream.status() : { enabled: false, state: 'off', since: null, lastEventAt: null, reconnects: 0, error: cfg.streamEnabled ? (cfg.streamUrl ? 'not started' : 'no stream URL: EVENTS_URL is not the Worker events address') : 'switched off (WORLD_STREAM=0)' }
  return { enabled: s.enabled, connected: s.state === 'open', state: s.state, since: s.since, lastEventAt: s.lastEventAt, nudges, nudgedScans, reconnects: s.reconnects, error: s.error }
}

/** Present on this machine = the Worker's ledger route is reachable in principle. Cheap; runs every poll. */
const detect = async () => {
  const on = Boolean(cfg.ledgerUrl && cfg.eventsBearerToken)
  if (on) {
    ensureOverlayApi()
    ensureStream()
  }
  return on
}
// U29: the sidecar is up from the moment the adapter loads, not from the first poll — the overlay's fetch seam holds the
// page's own state read until GET /world has answered (the layout is generated inside that answer), and the page's
// first poll comes after its state read; a sidecar that waited for the poll would never start. Never under npm test.
if (cfg.ledgerUrl && cfg.eventsBearerToken && cfg.overlayPort && !process.env.NODE_TEST_CONTEXT) ensureOverlayApi()
// U7: the stream likewise, from load (its socket is unref'd: a script that imports the adapter still exits).
if (cfg.ledgerUrl && cfg.eventsBearerToken && !process.env.NODE_TEST_CONTEXT) ensureStream()

/**
 * The skills with any event in the last STALE_DAYS days (U17 hand-raise). The Worker takes 6–9 s per scan
 * (measured 2026-09-07), so this never sits on the poll's path: a stale set is refreshed in the background
 * and the poll uses the last good one — null until the first refresh lands (no hands yet, honestly).
 */
let ranRefreshing = null
function ranSkills(now) {
  if ((!ranCache.ran || now - ranCache.at >= RAN_MS) && !ranRefreshing) {
    ranRefreshing = ledger
      .scanSince(new Date(now - STALE_DAYS * 24 * 3600 * 1000).toISOString(), { timeoutMs: cfg.ledgerLongTimeoutMs })
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
  // U16 backstop: every actor value in the window — run starts, taps, everything — for the PA's named-person check only
  const actors = [...new Set(events.map((e) => (typeof e?.actor === 'string' ? e.actor.trim() : '')).filter(Boolean))]
  lastScan = { at: now, runs, rowById, threads, projects, silent: stale.map((s) => s.name), live, failed, actors }

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

/**
 * The scan, cached for scanCacheMs (5 s) from when it finished, so the polls of several pages cost one query burst;
 * an event on the stream drops the cache (U7); the last good result survives a failed read.
 * U37: one scan at a time — polls that land while a scan runs share it, so Compass is read once however many pages
 * poll, and a slow scan can never finish after a newer one and report an outage that is already over.
 */
let scanning = null
function scanThreads() {
  if (Date.now() - scanCache.at < cfg.scanCacheMs) return Promise.resolve(scanCache.threads)
  if (!scanning) {
    const t = Date.now()
    if (t < earlyUntil) nudgedScans += 1 // before the dropped cache would have run out: early, because of an event
    earlyUntil = 0
    scanning = runScan(t).finally(() => (scanning = null))
  }
  return scanning
}

async function runScan(now) {
  try {
    // The cache counts from when the scan finished, not when it started: a 6–9 s scan stamped with its start was
    // already stale by the next poll, so the cache served nothing and the nudge had nothing to drop (U7 review).
    scanCache = { threads: await scan(now), at: Date.now() }
    health.ok()
  } catch (err) {
    if (now - lastErrorAt > 60_000) {
      lastErrorAt = now
      console.warn('bot-crossing: compass —', err?.message || err)
    }
    // The last good threads stay on screen — and the page is told they are old (U37).
    health.fail(err)
    scanCache = { at: Date.now(), threads: scanCache.threads }
  }
  scanFinishedAt = scanCache.at
  if (nudgedAt >= now) {
    // U7: an event landed while this scan ran — its answer is stale, and the next poll reads again. Without the event
    // that answer would have served polls until now + scanCacheMs: a scan before then is early.
    earlyUntil = Math.max(earlyUntil, scanFinishedAt + cfg.scanCacheMs)
    scanCache.at = 0
  }
  // The substrate is the world's map: when it is failing, the towns on screen are old (or missing) too.
  const sub = substrate.status?.()
  if (sub?.ok === true) health.ok('substrate')
  else if (sub?.ok === false) health.fail(sub.error, 'substrate')
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
export const _internals = { scan, cfg, viewer, ask, lastScan: () => lastScan, world: () => world, currentWorld, signals: () => signals, steering, health, invalidate: () => (scanCache = { at: 0, threads: scanCache.threads }), startStream: () => ensureStream({ inTest: true }), stream: streamSignal }
