/**
 * Compass adapter — the realtime nudge (U7, ES-1.10), over the Compass Worker's GET /events/stream.
 *
 * The spec's first design subscribed to Supabase Realtime (postgres_changes on ops_run_events) from this machine. That
 * was never possible: a subscription needs a Supabase key, and the Lovable-managed project exposes none (the reason U10
 * exists). The Worker now streams the ledger itself (approval layer P8, src/lib/approval/stream.ts in
 * tellefsen-compass-mcp): it reads ops_run_events every 2 s and sends what is new as server-sent events. This module
 * listens to that stream and calls `onEvent` for each ledger event; the adapter drops its scan cache, so the next poll
 * reads the ledger again instead of a cached answer.
 *
 * The contract, as the Worker serves it on main (2026-10-04):
 *   GET <EVENTS_URL>/stream, `Authorization: Bearer <EVENTS_BEARER_TOKEN>` (401 without it), GET only (405 otherwise)
 *   200 text/event-stream; first `retry: 1000` and a `: connected …` comment
 *   each event:  `id: <at>|<event id>` · `event: ledger` · `data: {id, run_id, event_type, skill, client, at, parent_run_id, payload}`
 *   `: keepalive` at least every 15 s; `event: error` with {error} when the Worker's own read fails
 *   each connection lives about 50 s and then closes; the client reconnects with `Last-Event-ID: <at>|<id>` and resumes
 *   exactly there (no id → it starts at "now"; it never reaches back more than 24 h). `?client=` filters; not used here.
 *
 * Bounded so it can never hold up a poll: the stream runs on its own, the adapter never waits for it, every wait has a
 * deadline (headers within the read deadline, then no more than `idleMs` of silence), a message larger than
 * `maxMessageBytes` is cut off, and failures back off exponentially up to `maxMs`. A stream that is down is not an
 * outage: the polls carry on, and nothing here feeds the "Compass unavailable" pill. Read only — one GET, never a write,
 * and the bearer goes only into the request header (never into status, logs or errors). Its sockets and timers are
 * unref'd, so a short script that imports the adapter still exits. Off with WORLD_STREAM=0.
 */
import http from 'node:http'
import https from 'node:https'

export const STREAM_DEFAULTS = Object.freeze({
  baseMs: 1000, // the first retry after a failure
  maxMs: 60_000, // the longest wait between tries; a refused bearer or a missing route waits this long at once
  minRetryMs: 500, // the floor on the Worker's own `retry:` hint, so no server can make the client spin
  idleMs: 45_000, // three keepalive periods of silence, and the connection is given up
  minLifeMs: 5_000, // a connection that closes sooner with no event sent counts as a failure, not a routine close
  maxMessageBytes: 1 << 20, // one event never needs a megabyte
  maxIdLength: 256, // `<at>|<uuid>` is ~60 characters; anything much longer is not a resume id
})

/**
 * Server-sent events parser — the WHATWG event-stream interpretation: lines end in CRLF, LF or CR (a CR at the end of a
 * chunk waits for the next one); `:` starts a comment; `event`, `data`, `id`, `retry` are the fields; a blank line
 * dispatches. An `id` with a NUL is ignored; the last id persists across messages, as the spec's last-event-id buffer does.
 */
export function createParser({ onMessage = () => {}, onComment = () => {}, onRetry = () => {}, maxBytes = STREAM_DEFAULTS.maxMessageBytes } = {}) {
  let buf = ''
  let data = []
  let dataBytes = 0
  let event = ''
  let lastEventId = ''

  function line(text) {
    if (text === '') {
      if (data.length) onMessage({ event: event || 'message', data: data.join('\n'), id: lastEventId })
      data = []
      dataBytes = 0
      event = ''
      return
    }
    if (text[0] === ':') return onComment(text.slice(1).trim())
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    let value = colon < 0 ? '' : text.slice(colon + 1)
    if (value[0] === ' ') value = value.slice(1)
    if (field === 'data') {
      data.push(value)
      dataBytes += value.length + 1
      if (dataBytes > maxBytes) throw new Error(`a message ran past ${maxBytes} bytes`)
    } else if (field === 'event') event = value
    else if (field === 'id') {
      if (!value.includes('\0')) lastEventId = value
    } else if (field === 'retry' && /^\d+$/.test(value)) onRetry(Number(value))
  }

  return {
    feed(chunk) {
      buf += chunk
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i]
        if (c !== '\n' && c !== '\r') continue
        if (c === '\r' && i === buf.length - 1) break // maybe the first half of a CRLF: wait for the next chunk
        line(buf.slice(start, i))
        if (c === '\r' && buf[i + 1] === '\n') i++
        start = i + 1
      }
      buf = buf.slice(start)
      if (buf.length > maxBytes) throw new Error(`a line ran past ${maxBytes} bytes`)
    },
    /** The stream ended: a CR held back as a possible CRLF was a line end after all. An unfinished event is dropped. */
    end() {
      if (buf.endsWith('\r')) {
        line(buf.slice(0, -1))
        buf = ''
      }
    },
    lastEventId: () => lastEventId,
  }
}

/**
 * The stream client. `start()` connects (a no-op when switched off or not configured) and returns whether it is on;
 * `stop()` ends it for good; `status()` is a small record for GET /world (signals.realtime) — never the token.
 * `onEvent(row)` receives each `event: ledger` row; it should be cheap (the adapter only drops a cache).
 */
export function createStream(cfg, { onEvent = () => {}, log = () => {}, warn = (...a) => console.warn(...a), now = Date.now, ...overrides } = {}) {
  const o = { ...STREAM_DEFAULTS, ...overrides }
  const connectMs = o.connectMs ?? cfg.readTimeoutMs ?? 10_000
  const enabled = Boolean(cfg.streamEnabled !== false && cfg.streamUrl && cfg.eventsBearerToken)
  const iso = (t) => (t ? new Date(t).toISOString() : null)
  const dur = (ms) => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`)
  let running = false
  let req = null
  let timer = null
  let lastEventId = ''
  let retryMs = 1000
  let failures = 0
  let warnedOutage = false
  let everOpen = false
  const SUBSCRIBED = 'bot-crossing: compass — realtime: subscribed ops_run_events (GET /events/stream)'
  const st = { state: 'off', since: now(), connectedAt: 0, lastEventAt: 0, events: 0, reconnects: 0, error: '', retryInMs: 0 }
  const set = (state, extra = {}) => Object.assign(st, { state, since: now() }, extra)
  const unref = (t) => (t?.unref?.(), t)

  function schedule(ms) {
    clearTimeout(timer)
    st.retryInMs = ms
    timer = unref(setTimeout(() => (timer = null, connect()), ms))
  }

  /** A try that did not work: say so once per outage, then back off — at once to the longest wait when retrying cannot help. */
  function failed(reason, { fatal = false } = {}) {
    if (!running) return
    failures += 1
    const ms = fatal ? o.maxMs : Math.min(o.maxMs, o.baseMs * 2 ** (failures - 1))
    set('waiting', { error: reason })
    if (!warnedOutage) {
      warnedOutage = true
      warn(`bot-crossing: compass — realtime: stream unavailable — ${reason}. The polls carry on; retrying in ${dur(ms)}, backing off.`)
    } else log(`realtime: ${reason} — retry ${failures} in ${ms} ms`)
    schedule(ms)
  }

  function connect() {
    if (!running) return
    set('connecting')
    st.reconnects += st.connectedAt ? 1 : 0
    const headers = { Authorization: `Bearer ${cfg.eventsBearerToken}`, Accept: 'text/event-stream', 'Cache-Control': 'no-store' }
    if (lastEventId && lastEventId.length <= o.maxIdLength) headers['Last-Event-ID'] = lastEventId
    const lib = String(cfg.streamUrl).startsWith('https:') ? https : http
    let done = false
    let openedAt = 0
    let sent = 0
    let idle = null
    let healthy = false
    let healthyTimer = null
    /**
     * An open connection is not yet a recovery: one that opens and then fails (a flapping Worker) must keep backing off
     * and stay one warning. It counts as healthy once it delivers an event or stays open for `minLifeMs`.
     */
    const markHealthy = () => {
      if (healthy || !running) return
      healthy = true
      if (failures > 0) warn(`${SUBSCRIBED} — back after ${failures} failed ${failures === 1 ? 'try' : 'tries'}`)
      failures = 0
      warnedOutage = false
    }
    const finish = (fn) => {
      if (done) return
      done = true
      clearTimeout(deadline)
      clearTimeout(idle)
      clearTimeout(healthyTimer)
      try {
        req?.destroy()
      } catch { /* already gone */ }
      req = null
      fn()
    }
    const deadline = unref(setTimeout(() => finish(() => failed(`GET /events/stream did not answer within ${dur(connectMs)}`)), connectMs))
    const quiet = () => {
      clearTimeout(idle)
      idle = unref(setTimeout(() => finish(() => failed(`GET /events/stream went quiet for ${dur(o.idleMs)}`)), o.idleMs))
    }
    try {
      req = lib.get(cfg.streamUrl, { headers, agent: false }, (res) => {
        clearTimeout(deadline)
        const type = String(res.headers['content-type'] || '')
        if (res.statusCode !== 200 || !/^text\/event-stream/i.test(type)) {
          res.resume()
          const s = res.statusCode
          const reason = s === 401 || s === 403 ? `the Worker refused the events bearer (${s})`
            : s === 404 || s === 405 ? `the Worker has no GET /events/stream (${s}) — not deployed yet?`
            : s !== 200 ? `GET /events/stream answered ${s}` : 'GET /events/stream did not answer with text/event-stream'
          return finish(() => failed(reason, { fatal: s === 401 || s === 403 || s === 404 || s === 405 }))
        }
        openedAt = now()
        set('open', { connectedAt: openedAt, error: '', retryInMs: 0 })
        if (!everOpen && failures === 0) warn(SUBSCRIBED) // the first subscribe is said at once; a recovery when it holds
        else log('realtime: stream open')
        everOpen = true
        healthyTimer = unref(setTimeout(markHealthy, o.minLifeMs))
        quiet()
        const parser = createParser({
          maxBytes: o.maxMessageBytes,
          onRetry: (ms) => (retryMs = ms),
          onMessage: (m) => {
            if (m.event === 'error') return log(`realtime: the Worker reported ${m.data.slice(0, 200)}`)
            if (m.event !== 'ledger') return
            let row = null
            try {
              row = JSON.parse(m.data)
            } catch {
              return log('realtime: an event whose data is not JSON — skipped')
            }
            if (!row || typeof row !== 'object') return
            sent += 1
            st.events += 1
            st.lastEventAt = now()
            markHealthy()
            try {
              onEvent(row)
            } catch (err) {
              log(`realtime: onEvent failed — ${err?.message || err}`)
            }
          },
        })
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          if (done) return
          quiet()
          try {
            parser.feed(chunk)
            lastEventId = parser.lastEventId() || lastEventId // the resume point travels with each event (`<at>|<id>`)
          } catch (err) {
            finish(() => failed(`GET /events/stream: ${err.message}`))
          }
        })
        res.on('end', () =>
          finish(() => {
            try {
              parser.end()
              lastEventId = parser.lastEventId() || lastEventId
            } catch { /* a last line past the bound: dropped */ }
            if (!running) return
            const lived = now() - openedAt
            if (!healthy && sent === 0 && lived < o.minLifeMs) return failed(`GET /events/stream closed after ${lived} ms with nothing sent`)
            markHealthy() // the routine close of a connection that held
            const wait = Math.min(o.maxMs, Math.max(o.minRetryMs, retryMs))
            set('waiting', { error: '' })
            log(`realtime: the Worker closed the stream after ${Math.round(lived / 1000)} s — reconnecting in ${wait} ms${lastEventId ? ' with Last-Event-ID' : ''}`)
            schedule(wait)
          })
        )
        res.on('error', (err) => finish(() => failed(`GET /events/stream: ${err?.code || err?.message || err}`)))
        res.on('close', () => finish(() => failed('GET /events/stream: the connection dropped')))
      })
      req.on('socket', (socket) => socket.unref?.())
      req.on('error', (err) => finish(() => failed(`GET /events/stream: ${err?.code || err?.message || err}`)))
    } catch (err) {
      // a header the runtime refuses (e.g. a resume id with a control character): drop the id and try again
      lastEventId = ''
      finish(() => failed(`GET /events/stream could not be requested: ${err?.code || err?.message || err}`))
    }
  }

  return {
    start() {
      if (!enabled) {
        set('off', { error: cfg.streamEnabled === false ? 'switched off (WORLD_STREAM=0)' : 'not configured' })
        return false
      }
      if (running) return true
      running = true
      connect()
      return true
    },
    stop() {
      running = false
      clearTimeout(timer)
      timer = null
      try {
        req?.destroy()
      } catch { /* already gone */ }
      req = null
      set('off', { retryInMs: 0 })
    },
    status() {
      return { enabled, state: st.state, since: iso(st.since), connectedAt: iso(st.connectedAt), lastEventAt: iso(st.lastEventAt), events: st.events, reconnects: st.reconnects, failures, error: st.error, retryInMs: st.retryInMs }
    },
  }
}
