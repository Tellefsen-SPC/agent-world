/**
 * Overlay sidecar (U12) — the adapter's own loopback listener beside the world.
 *
 * Bot Crossing's API (server/api.mjs, never edited) knows one layout file and no planets. The
 * overlay needs two things the seam does not carry: the world's shape (planets, towns, packs,
 * viewer) and a layout file per planet. This serves both on a second loopback port; the overlay
 * routes a non-home planet's state here and leaves data/colony.json to the API.
 *
 *   OPTIONS *                      CORS preflight (local origins only)
 *   GET  /world                    { at, viewer, home, planets, towns, campus, signals }
 *   GET  /steering                 { at, pipeline, milestones, decisions } — U19's three panels (kept for the readers; re-homed in /rooms)
 *   GET  /rooms                    { at, rooms: { <room id>: panel }, missingEnv } — the room panels (U31), 5-min caches
 *   GET  /rooms/<id>               one room's panel
 *   GET  /archive                  { at, shelves, byProject, missing } — the archive shelves (U32), 5-min caches
 *   GET  /spend[?window=n&include_test=1]  the Worker's GET /world/spend object (U35), 60-s cache per window; the overlay folds it
 *                                  — Owner only: any other viewer gets 403 {error} and the Worker is not read (ADR 0005)
 *   GET  /spend/today[?include_test=1]     today's cost per town — the Worker's GET /ledger/cost?days=1 (U37, from Compass U5)
 *                                  — Owner only, as /spend
 *   GET  /planets/<key>/state      that planet's data/colony.<key>.json — created empty on first read
 *   PUT  /planets/<key>/state      write it (same field whitelist as api.mjs; the browser is the one writer) — only for a
 *                                  viewer with the `layout` capability (viewer.mjs presets: Owner); anyone else gets 403 {error}
 *   POST /ask                      the PA (U16, ES-4.6): {question, context} → the Worker's POST /ask through compass/ask.mjs,
 *                                  which holds the bearer — the browser never does (docs/adr/0008). Only for a viewer with
 *                                  the `ask` capability (Owner), the world's own page as Origin (loopback host AND the
 *                                  page's port, cfg.pagePort) and Content-Type application/json; the body at most 8 KB
 *                                  (a bigger one, chunked or not, gets its 413 before the connection closes). The Worker's
 *                                  status comes back with its body cut to spec/ask.v1.json.
 *
 * Writes only data/colony.<key>.json for a planet the substrate names, never the home file, never
 * anything else. Same Host + Origin discipline as api.mjs: loopback hosts, and a state change needs
 * a local Origin. Nothing here touches a token — the ask's bearer lives in compass/ask.mjs — and nothing here logs a
 * question or an answer.
 *
 * Who is asking: `viewerFor(req)` returns the viewer for this request (viewer.mjs). Today the adapter hands back its one
 * viewer from WORLD_VIEWER_PRESET; at M3 the identity comes from the hosted world's sign-in (Cloudflare Access is proposed: ADR 0006, D10, to ratify) and only viewerFor changes.
 * The server decides what a viewer may have — the overlay's own checks (overlay/spend.mjs showSpend) are a second line,
 * never the only one. No viewer, or one that cannot be resolved, is refused: the gates fail closed.
 */
import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', '..', '..', 'data')
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const STATE_VERSION = 1

/** Spend is the Owner's (Component 9, ES-4.13; ADR 0005) — the same rule the overlay applies (overlay/spend.mjs showSpend). */
export const mayReadSpend = (viewer) => viewer?.preset === 'owner'
/** The layout file is the world's only write; it needs the `layout` capability (viewer.mjs: Owner). */
export const mayWriteLayout = (viewer) =>
  typeof viewer?.canWriteLayout === 'function' ? viewer.canWriteLayout() === true : Array.isArray(viewer?.capabilities) && viewer.capabilities.includes('layout')
/** The PA is asked only by a viewer holding `ask` (viewer.mjs: Owner) — every question spends tokens on the Worker. */
export const mayAsk = (viewer) =>
  typeof viewer?.canAsk === 'function' ? viewer.canAsk() === true : Array.isArray(viewer?.capabilities) && viewer.capabilities.includes('ask')
/** The Worker's own bound on the ask body (docs/ask.md): a bigger one is refused here and never sent. */
export const ASK_BODY_LIMIT = 8 * 1024

/**
 * The world's own page, and nothing else on this machine: http, a loopback host, and the page's port. Any local
 * origin will do for the layout seam (as in api.mjs); the PA spends tokens, so another local page — a second dev server,
 * a tool on another port — may not ask it (review nit 6).
 */
export function isPageOrigin(origin, pagePort) {
  try {
    const u = new URL(String(origin))
    return u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.replace(/^\[|\]$/g, '')) && u.port === String(pagePort)
  } catch {
    return false
  }
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])
export const emptyState = () => ({ version: STATE_VERSION, archived: [], archivedAt: {}, opened: [], plots: {}, seen: {}, settings: null, updatedAt: 0 })
const shape = (raw) => ({
  version: STATE_VERSION,
  archived: asArray(raw.archived),
  archivedAt: asObject(raw.archivedAt),
  opened: asArray(raw.opened),
  plots: asObject(raw.plots),
  seen: asObject(raw.seen),
  settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
  updatedAt: Number(raw.updatedAt) || 0,
})

function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * The body as JSON, or a rejection. Past `limit` the rest of the body is read and dropped rather than the socket cut,
 * so the caller can still answer 413 (review nit 9: a chunked body over the limit used to get a reset, not an answer);
 * the caller answers with Connection: close, which ends the socket once the answer is out.
 */
function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let over = false
    const chunks = []
    req.on('data', (c) => {
      if (over) return
      size += c.length
      if (size > limit) {
        over = true
        chunks.length = 0
        reject(Object.assign(new Error('Body too large'), { code: 'too_large' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (over) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param getWorld  async () => the derived world (zones.mjs) — planets decide which files exist
 * @param descriptor () => the JSON for GET /world (may be async)
 * @param dataDir   where colony.<key>.json files live
 */
export function createOverlayApi({ getWorld, descriptor, steering = null, rooms = null, archive = null, spend = null, ask = null, viewerFor = () => null, pagePort = 5274, dataDir = DEFAULT_DATA_DIR, log = () => {} }) {
  const fileFor = (key) => path.join(dataDir, `colony.${key}.json`)
  /** The viewer for this request, or null — a viewerFor that throws is no viewer (fail closed). */
  const viewerOf = (req) => {
    try {
      return viewerFor(req) || null
    } catch {
      return null
    }
  }

  async function readState(key) {
    try {
      return shape(JSON.parse(await fsp.readFile(fileFor(key), 'utf8')))
    } catch {
      return null
    }
  }

  async function writeState(key, next) {
    const state = { ...shape(next), updatedAt: Date.now() }
    await fsp.mkdir(dataDir, { recursive: true })
    const tmp = fileFor(key) + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
    await fsp.rename(tmp, fileFor(key))
    return state
  }

  /** A key the substrate names, and not the home planet (that file belongs to api.mjs). */
  async function planetFile(key) {
    if (!KEY.test(key)) return null
    const world = await getWorld()
    const planet = world.planets.find((p) => p.key === key)
    return planet && !planet.home ? planet : null
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const origin = req.headers.origin
    const originLocal = origin && origin !== 'null' && LOCAL_HOSTS.has(hostnameOf(origin))
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
    if (originLocal) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, OPTIONS'
      headers['Access-Control-Allow-Headers'] = 'Content-Type'
    }
    const send = (status, body, extra = {}) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, { ...headers, ...extra, 'Content-Length': Buffer.byteLength(payload) })
      res.end(payload)
    }
    /** 413, then close: the answer goes out first; Connection: close has Node end the socket once it has (test/ask.test.mjs). */
    const tooLarge = (limit) => send(413, { error: `body exceeds ${limit} bytes` }, { Connection: 'close' })

    if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return send(403, { error: 'Agent World only answers its own page on this machine' })
    if (req.method === 'OPTIONS') {
      // the PA's preflight passes only for the world's own page (nit 6); the rest as before
      const ok = url.pathname === '/ask' ? isPageOrigin(origin, pagePort) : originLocal
      res.writeHead(ok ? 204 : 403, headers)
      return res.end()
    }
    // A state change needs the page's own Origin; a bare GET (curl) is fine, as in api.mjs.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !originLocal) return send(403, { error: 'Origin required' })

    try {
      if (url.pathname === '/world' && req.method === 'GET') return send(200, await descriptor())
      if (url.pathname === '/steering' && req.method === 'GET') return steering ? send(200, await steering()) : send(404, { error: 'No steering room on this adapter' })
      if (url.pathname === '/rooms' && req.method === 'GET') return rooms ? send(200, await rooms.all()) : send(404, { error: 'No room panels on this adapter' })
      const room = url.pathname.match(/^\/rooms\/([a-z0-9-]+)$/)
      if (room && req.method === 'GET') {
        if (!rooms) return send(404, { error: 'No room panels on this adapter' })
        const panel = await rooms.one(room[1])
        return panel ? send(200, panel) : send(404, { error: 'No such room' })
      }
      if (url.pathname === '/archive' && req.method === 'GET') return archive ? send(200, await archive.shelf()) : send(404, { error: 'No archive on this adapter' })
      if ((url.pathname === '/spend' || url.pathname === '/spend/today') && req.method === 'GET' && !mayReadSpend(viewerOf(req))) {
        // Before any read: a viewer who may not see cost never causes a Worker read, and the refusal carries no figure.
        return send(403, { error: 'Spend is shown to the Owner only' })
      }
      if (url.pathname === '/spend/today' && req.method === 'GET') {
        // U37: today's cost per town, read as /spend is (60-s cache, last good kept); a town card draws its line from it
        if (!spend?.today) return send(404, { error: "No today's cost on this adapter" })
        return send(200, await spend.today({ includeTest: url.searchParams.get('include_test') === '1' }))
      }
      if (url.pathname === '/spend' && req.method === 'GET') {
        // U35: the Worker's spend object as read (60-s cache per window); include_test=1 keeps the zztest-% rows in, as the Worker does
        if (!spend) return send(404, { error: 'No spend on this adapter' })
        return send(200, await spend.read({ window: url.searchParams.get('window') ?? undefined, includeTest: url.searchParams.get('include_test') === '1' }))
      }

      if (url.pathname === '/ask') {
        // U16: the PA. A local Origin was required above (a POST is a state change to this listener); then, in order and
        // before the body is read: the method, the world's own page as Origin (host and port), the `ask` capability
        // (Owner), a JSON body of at most 8 KB. Then the
        // forwarder (compass/ask.mjs) checks the body the way the Worker will, asks, and cuts the answer to the contract.
        if (req.method !== 'POST') return send(405, { error: 'Method not allowed: POST a question' }, { Allow: 'POST' })
        if (!isPageOrigin(origin, pagePort)) return send(403, { error: `The PA answers the world's own page only (http://127.0.0.1:${pagePort})` })
        if (!mayAsk(viewerOf(req))) return send(403, { error: 'The PA answers the Owner only' })
        if (!ask) return send(404, { error: 'No PA on this adapter' })
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, { error: 'Content-Type must be application/json' })
        if (Number(req.headers['content-length'] || 0) > ASK_BODY_LIMIT) return tooLarge(ASK_BODY_LIMIT)
        let body
        try {
          body = await readJsonBody(req, ASK_BODY_LIMIT)
        } catch (err) {
          return err?.code === 'too_large' ? tooLarge(ASK_BODY_LIMIT) : send(400, { error: 'body must be JSON: {"question": "…", "context": {…}}' })
        }
        const out = await ask.ask(body)
        return send(out.status, out.body, out.headers || {})
      }

      const m = url.pathname.match(/^\/planets\/([^/]+)\/state$/)
      if (m) {
        // The layout is written only by a viewer who holds `layout`; checked before the planet or the body is looked at.
        if (req.method === 'PUT' && !mayWriteLayout(viewerOf(req))) return send(403, { error: 'Only a viewer with the layout capability may move plots' })
        const key = decodeURIComponent(m[1])
        const planet = await planetFile(key)
        if (!planet) return send(404, { error: 'No such planet here (the home planet lives at /api/state)' })
        if (req.method === 'GET') {
          let state = await readState(key)
          if (!state) {
            // Created on first render (ES-4.2) — the only write this route makes unasked.
            state = await writeState(key, emptyState())
            log(`planet ${key}: created ${path.relative(process.cwd(), fileFor(key))}`)
          }
          return send(200, state)
        }
        if (req.method === 'PUT') return send(200, await writeState(key, await readJsonBody(req)))
        return send(405, { error: 'Method not allowed' })
      }
      return send(404, { error: 'Unknown endpoint' })
    } catch (err) {
      if (err?.code === 'too_large') return tooLarge(4 * 1024 * 1024) // a layout PUT past 4 MB: 413, as /ask
      return send(500, { error: String(err && err.message ? err.message : err) })
    }
  }
}

/**
 * Listen on both loopback addresses (the page resolves `localhost` to either), unref'd so the
 * world's own process never waits on this. A port already taken — a second copy of the world —
 * is warned once and skipped; the overlay then falls back to the home planet only.
 */
export async function startOverlayApi(handle, { port, log = () => {} } = {}) {
  // Vite restarts the dev server in-process when a server file changes (the adapter is re-imported); the previous
  // instance's listeners would keep the port and answer with the old module's closures. Close them first.
  const prev = globalThis.__awOverlayApi
  if (prev?.close) {
    try {
      await prev.close()
      log('overlay api: previous instance closed')
    } catch { /* already gone */ }
    globalThis.__awOverlayApi = null
  }
  const servers = []
  const listen = (host) =>
    new Promise((resolve) => {
      const server = http.createServer(handle)
      server.on('error', (err) => {
        if (err?.code !== 'EAFNOSUPPORT' && err?.code !== 'EADDRNOTAVAIL') console.warn(`bot-crossing: compass — overlay api on ${host}:${port} —`, err?.message || err)
        resolve(null)
      })
      server.listen(port, host, () => {
        server.unref()
        servers.push(server)
        resolve(server)
      })
    })
  return Promise.all([listen('127.0.0.1'), listen('::1')]).then((list) => {
    const up = list.filter(Boolean)
    if (up.length) log(`overlay api listening on ${up.map((s) => `${s.address().address}:${s.address().port}`).join(' and ')}`)
    const api = {
      port: up[0]?.address().port || 0,
      servers: up,
      close: () => Promise.all(up.map((s) => new Promise((r) => s.close(r)))),
    }
    globalThis.__awOverlayApi = api
    return api
  })
}
