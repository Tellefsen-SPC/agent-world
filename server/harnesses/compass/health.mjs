/**
 * Compass adapter — staying honest when Compass is down (U37 — the Engineering spine's U8).
 *
 * Before this, a Compass that did not answer was a warning in the server log once a minute, and a Compass
 * that answered slowly held the scan for as long as it liked: the world kept showing its last answer with
 * nothing on screen to say it was old. Now every Compass read has a deadline, the ledger scan retries a
 * transient failure once, and the adapter keeps a small record of whether Compass is answering — served
 * with GET /world as signals.compass, and drawn by the overlay as a pill on the strip (overlay/signals.mjs).
 *
 * Read only, like the rest of the adapter. The record carries times and a short reason — never a token.
 */

/**
 * A fetch that gives up after `ms`, with a reason a person can read. The deadline covers the body as well as
 * the headers — a body that stalls half-way is the same outage — and ends when the body has been read. A response
 * whose body is never read keeps its timer, unref'd: the abort is harmless and never holds the process open.
 */
export function withTimeout(fetchImpl, ms) {
  const after = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`
  return async (url, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    timer.unref?.()
    const timedOut = () => Object.assign(new Error(`${routeOf(url)} did not answer within ${after}`), { name: 'TimeoutError' })
    let res
    try {
      res = await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (err) {
      clearTimeout(timer)
      throw controller.signal.aborted ? timedOut() : err
    }
    const body = (read) => async () => {
      try {
        return await read()
      } catch (err) {
        throw controller.signal.aborted ? timedOut() : err
      } finally {
        clearTimeout(timer)
      }
    }
    return { ok: res.ok, status: res.status, headers: res.headers, json: body(() => res.json()), text: body(() => res.text()) }
  }
}

/** Worth one retry: the network failed, or the Worker or its database said "try again". */
export const isTransientStatus = (status) => status === 502 || status === 503 || status === 504

/**
 * Whether Compass is answering, per read the world cannot do without: `ok(source)` after a good read,
 * `fail(err, source)` after a failed one (source defaults to the ledger scan; the substrate is the other).
 * `snapshot()` is what GET /world serves: { ok, downSince, lastGoodAt, error } — ok null until a read has finished,
 * false while any source is failing; downSince the earliest failure still standing; lastGoodAt when the failing
 * sources last answered (null if one never has); failing the names of the sources that are down.
 */
export function createHealth({ now = Date.now } = {}) {
  const sources = new Map()
  const iso = (t) => (t == null ? null : new Date(t).toISOString())
  return {
    ok(source = 'ledger') {
      sources.set(source, { ok: true, downSince: null, lastGoodAt: now(), error: null })
    },
    fail(err, source = 'ledger') {
      const was = sources.get(source)
      sources.set(source, { ok: false, downSince: was?.downSince ?? now(), lastGoodAt: was?.lastGoodAt ?? null, error: reason(err) })
    },
    snapshot() {
      const all = [...sources.entries()]
      if (!all.length) return { ok: null, downSince: null, lastGoodAt: null, error: null, failing: [] }
      const down = all.filter(([, s]) => !s.ok)
      if (!down.length) return { ok: true, downSince: null, lastGoodAt: iso(Math.max(...all.map(([, s]) => s.lastGoodAt))), error: null, failing: [] }
      const goods = down.map(([, s]) => s.lastGoodAt)
      return {
        ok: false,
        downSince: iso(Math.min(...down.map(([, s]) => s.downSince))),
        lastGoodAt: goods.includes(null) ? null : iso(Math.min(...goods)),
        error: down.map(([name, s]) => (s.error.startsWith(name) ? s.error : `${name}: ${s.error}`)).join('; ').slice(0, 160),
        failing: down.map(([name]) => name),
      }
    },
  }
}

const reason = (err) => String(err?.message || err || 'no answer').slice(0, 160)

function routeOf(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return 'Compass'
  }
}
