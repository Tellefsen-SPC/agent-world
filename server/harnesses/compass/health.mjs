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

/** A fetch that gives up after `ms`, with a reason a person can read. */
export function withTimeout(fetchImpl, ms) {
  return async (url, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal })
    } catch (err) {
      if (controller.signal.aborted) {
        const after = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`
        throw Object.assign(new Error(`${routeOf(url)} did not answer within ${after}`), { name: 'TimeoutError' })
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Worth one retry: the network failed, or the Worker or its database said "try again". */
export const isTransientStatus = (status) => status === 502 || status === 503 || status === 504

/**
 * Whether Compass is answering. `ok()` after a good scan, `fail(err)` after a failed one; `snapshot()` is what
 * GET /world serves: { ok, downSince, lastGoodAt, error } — null until the first scan has finished.
 */
export function createHealth({ now = Date.now } = {}) {
  let state = { ok: null, downSince: null, lastGoodAt: null, error: null }
  return {
    ok() {
      state = { ok: true, downSince: null, lastGoodAt: now(), error: null }
    },
    fail(err) {
      state = { ok: false, downSince: state.downSince ?? now(), lastGoodAt: state.lastGoodAt, error: reason(err) }
    },
    snapshot() {
      const iso = (t) => (t == null ? null : new Date(t).toISOString())
      return { ok: state.ok, downSince: iso(state.downSince), lastGoodAt: iso(state.lastGoodAt), error: state.error }
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
