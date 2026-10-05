/**
 * Compass adapter — the PA's question, forwarded (U16W wiring; ES-4.6; docs/adr/0008).
 *
 * The PA panel (overlay/pa.mjs, U16) asks a question about a run, a town or a milestone. The Worker answers it at
 * `POST /ask` (tellefsen-compass-mcp, branch compass-ask: docs/ask.md) — the one model call in the Agent World stack,
 * a governed run of its own on the Worker. The browser never holds the Worker's bearer: it asks the sidecar's
 * `POST /ask` (overlay-api.mjs), which hands the body here; this module checks and bounds it, forwards it with the
 * bearer and a deadline, and passes the Worker's status back with a body cut to spec/ask.v1.json.
 *
 * What it does not do:
 *  - write anything: the ask's run_started / run_completed and its ops_skill_runs row are the Worker's own record of
 *    its own model call (ES-4.6). The world writes no event, no row, no surface;
 *  - log the question or the answer: a log line carries the status, the error code and the PA's own run id;
 *  - ask about a person: the context carries places, a run id, a milestone and a project, never a person (Annex III;
 *    the Worker refuses person questions itself, and the panel never invites them);
 *  - ask twice at once: one question in flight per process — each one spends tokens.
 */
import { withTimeout } from './health.mjs'

/** The Worker's bounds (src/lib/ask-endpoint.ts), checked here first so a bad body never leaves the machine. */
export const MAX_BODY_BYTES = 8 * 1024
export const MAX_QUESTION_CHARS = 1000
export const MAX_CONTEXT_TEXT = 200
export const CONTEXT_KEYS = Object.freeze(['run_id', 'client', 'town', 'zone', 'milestone', 'project'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/**
 * The body the Worker takes, or { error }. Mirrors the Worker's parseAsk: {question, context?}; the question 1–1000
 * characters after trimming, no control characters but newline and tab; context only the six keys; run_id a uuid;
 * a place, milestone or project up to 200 characters with no quote, backslash or control character; zone is the
 * panel's word for town and is sent as town (the two must agree).
 */
export function parseQuestion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'question is required: send {"question": "…", "context": {…}}' }
  for (const k of Object.keys(body)) if (k !== 'question' && k !== 'context') return { error: `unknown field "${k.slice(0, 40)}"; the body is {question, context?}` }
  if (typeof body.question !== 'string' || !body.question.trim()) return { error: 'question is required: send {"question": "…", "context": {…}}' }
  const question = body.question.trim()
  if (question.length > MAX_QUESTION_CHARS) return { error: `question exceeds ${MAX_QUESTION_CHARS} characters` }
  if (CONTROL.test(question)) return { error: 'question contains control characters' }
  const context = {}
  if (body.context !== undefined && body.context !== null) {
    if (typeof body.context !== 'object' || Array.isArray(body.context)) return { error: 'context must be an object' }
    const c = body.context
    for (const k of Object.keys(c)) if (!CONTEXT_KEYS.includes(k)) return { error: `unknown context field "${k.slice(0, 40)}"; context takes run_id, client, town, milestone, project` }
    if (c.run_id !== undefined && c.run_id !== null && c.run_id !== '') {
      if (typeof c.run_id !== 'string' || !UUID_RE.test(c.run_id)) return { error: 'context.run_id must be a uuid' }
      context.run_id = c.run_id.toLowerCase()
    }
    for (const key of ['client', 'town', 'zone', 'project', 'milestone']) {
      const v = c[key]
      if (v === undefined || v === null || v === '') continue
      if (typeof v !== 'string') return { error: `context.${key} must be a string` }
      const t = v.trim()
      if (!t) continue
      if (t.length > MAX_CONTEXT_TEXT) return { error: `context.${key} exceeds ${MAX_CONTEXT_TEXT} characters` }
      if (CONTROL.test(t) || /["\\]/.test(t)) return { error: `context.${key} may not contain quotes, backslashes or control characters` }
      if (key === 'zone' || key === 'town') {
        if (context.town && context.town !== t) return { error: 'context.zone and context.town disagree; send one' }
        context.town = t
      } else context[key] = t
    }
  }
  return { question, context }
}

// ─── The answer, cut to spec/ask.v1.json ─────────────────────────────────────────────────────

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
const bool = (v) => v === true

/** One "Based on" entry: what the Worker read (or named and did not read), as a reference and a label. */
function basedOnEntry(v) {
  const b = obj(v)
  const ref = str(b?.ref, 300)
  const label = str(b?.label, 300)
  if (!ref || !label) return null
  const out = { ref, label, read: b.read === true }
  if (count(b.rows) !== null) out.rows = b.rows
  if (typeof b.version === 'string' || b.version === null) out.version = b.version === null ? null : b.version.slice(0, 40)
  if (typeof b.note === 'string') out.note = b.note.slice(0, 300)
  return out
}

function usageOf(v) {
  const u = obj(v)
  if (!u || count(u.input_tokens) === null || count(u.output_tokens) === null) return null
  const out = { input_tokens: u.input_tokens, output_tokens: u.output_tokens }
  for (const k of ['cache_creation_input_tokens', 'cache_read_input_tokens']) if (count(u[k]) !== null) out[k] = u[k]
  return out
}

function ledgerOf(v) {
  const l = obj(v)
  if (!l) return null
  const out = { run_started: bool(l.run_started) }
  if (typeof l.run_completed === 'boolean') out.run_completed = l.run_completed
  if (typeof l.run_failed === 'boolean') out.run_failed = l.run_failed
  out.row = str(l.row, 40)
  return out
}

/** A 200's body cut to the contract, or null when it is not an answer (no answer text) — then the sidecar says so. */
export function normaliseAnswer(body) {
  const b = obj(body)
  const answer = str(b?.answer, 20_000)
  if (!answer || !answer.trim()) return null
  const out = {
    answer,
    based_on: (Array.isArray(b.based_on) ? b.based_on : []).map(basedOnEntry).filter(Boolean).slice(0, 40),
    run_id: str(b.run_id, 64),
    model: str(b.model, 120),
    provider: str(b.provider, 40),
    usage: usageOf(b.usage),
    tokens_in: count(b.tokens_in),
    tokens_out: count(b.tokens_out),
    truncated: bool(b.truncated),
    ledger: ledgerOf(b.ledger),
  }
  if (b.refused === true) {
    out.refused = true
    out.reason = str(b.reason, 40) || 'annex_iii'
    if (b.withheld === true) out.withheld = true
  }
  return out
}

/** An error's body cut to the contract: the Worker's code and sentence, the PA's run id when it has one, the wait on a 429. */
export function normaliseError(status, body, retryAfter = null) {
  const b = obj(body)
  const code = str(b?.error, 80)
  const out = { error: code && code.trim() ? code : `http_${status}` }
  const detail = str(b?.detail, 1000)
  if (detail) out.detail = detail
  for (const k of ['run_id', 'provider', 'model']) {
    const v = str(b?.[k], k === 'model' ? 120 : 64)
    if (v) out[k] = v
  }
  if (status === 429) {
    if (retryAfter !== null) out.retry_after = retryAfter
    for (const k of ['asks_today', 'tokens_today', 'limit', 'token_limit']) if (count(b?.[k]) !== null) out[k] = b[k]
  }
  return out
}

/** Retry-After as whole seconds: a number of seconds, or an HTTP date from now; null when it is neither. */
export function retryAfterOf(value, now = Date.now()) {
  const v = String(value ?? '').trim()
  if (/^\d+$/.test(v)) return Number(v)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

// ─── The forwarder ───────────────────────────────────────────────────────────────────────────

/**
 * ask(body) → { status, body, headers }: the Worker's status and its body cut to the contract, or one of the sidecar's
 * own answers — 400 a body the Worker would refuse (never sent) · 409 a question already in flight · 503
 * world_not_configured (no /ask URL or no bearer on this machine) · 504 worker_timeout · 502 worker_unreachable · 502
 * bad_answer (a 200 that is not an answer).
 */
export function createAsk(cfg, { fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.askTimeoutMs ?? 40_000)
  const after = `${Math.round((cfg.askTimeoutMs ?? 40_000) / 1000)} s`
  let inFlight = false

  async function ask(body) {
    const parsed = parseQuestion(body)
    if (parsed.error) return { status: 400, body: { error: parsed.error }, headers: {} }
    if (!cfg.askUrl || !cfg.askBearerToken) {
      return {
        status: 503,
        body: { error: 'world_not_configured', detail: "This machine cannot reach the PA: EVENTS_URL must be the Worker's events address and EVENTS_BEARER_TOKEN (or WORLD_ASK_BEARER) must be set in .env." },
        headers: {},
      }
    }
    if (inFlight) return { status: 409, body: { error: 'ask_in_flight', detail: 'One question at a time: the last one is still being answered.' }, headers: {} }
    inFlight = true
    const started = now()
    const done = (status, out, headers = {}) => {
      // the status, the code and the PA's own run id — never the question, never the answer, never the detail
      const what = status === 200 ? (out.refused ? 'refused' : 'answered') : out.error
      log(`ask: ${status} ${what}${out.run_id ? ` · run ${String(out.run_id).slice(0, 8)}` : ''} · ${now() - started} ms`)
      return { status, body: out, headers }
    }
    try {
      let res
      try {
        res = await fetchImpl(cfg.askUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.askBearerToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ question: parsed.question, context: parsed.context }),
        })
      } catch (err) {
        return err?.name === 'TimeoutError'
          ? done(504, { error: 'worker_timeout', detail: `The Worker did not answer within ${after}.` })
          : done(502, { error: 'worker_unreachable', detail: 'The Worker could not be reached from this machine.' })
      }
      let payload = null
      try {
        payload = await res.json()
      } catch (err) {
        if (err?.name === 'TimeoutError') return done(504, { error: 'worker_timeout', detail: `The Worker did not finish its answer within ${after}.` })
        payload = null // an error page that is not JSON: the status speaks for it
      }
      if (res.status === 200) {
        const answer = normaliseAnswer(payload)
        return answer ? done(200, answer) : done(502, { error: 'bad_answer', detail: 'The Worker answered 200 without an answer in the shape spec/ask.v1.json names.' })
      }
      const status = Number.isInteger(res.status) && res.status >= 400 && res.status <= 599 ? res.status : 502
      const retryAfter = status === 429 ? retryAfterOf(res.headers?.get?.('retry-after'), now()) : null
      return done(status, normaliseError(status, payload, retryAfter), retryAfter !== null ? { 'Retry-After': String(retryAfter) } : {})
    } finally {
      inFlight = false
    }
  }

  return { ask, inFlight: () => inFlight }
}
