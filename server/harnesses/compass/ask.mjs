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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withTimeout } from './health.mjs'
import { ASK_TIMEOUT_MS } from './config.mjs'

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
//
// Keys AND values: every value is checked against the schema file itself (its types, enums, patterns and minimums), so
// a reason, a provider or a run id the contract does not name never reaches the panel. A value that does not fit is
// dropped when the schema has it optional, set to null when the schema allows null, and otherwise the whole answer is
// refused (bad_answer). Every string the Worker sent has the bearer's value cut out first (nit 7).

const here = path.dirname(fileURLToPath(import.meta.url))
export const SCHEMA = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'spec', 'ask.v1.json'), 'utf8'))
const ERROR_SCHEMA = SCHEMA.$defs.error

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const isType = (v, t) => (t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t)
/**
 * Whether `value` fits `schema` — the subset spec/ask.v1.json uses (type, enum, pattern, minimum, maximum, required,
 * properties, additionalProperties false, items). Its own code on purpose: the contract test checks this module's
 * output with test/lib/validate.mjs, so the two never share a mistake.
 */
export function fits(schema, value) {
  if (!schema || typeof schema !== 'object') return true
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => isType(value, t))) return false
  }
  if (schema.enum && !schema.enum.includes(value)) return false
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) return false
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
  }
  if (Array.isArray(value) && schema.items && !value.every((v) => fits(schema.items, v))) return false
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required || []) if (!(k in value)) return false
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k]
      if (!sub) {
        if (schema.additionalProperties === false) return false
        continue
      }
      if (!fits(sub, v)) return false
    }
  }
  return true
}

/** The bearer values to cut out of anything passed through: long enough to be a token, so a short one cannot mangle text. */
export const secretsOf = (...tokens) => [...new Set(tokens.map((t) => String(t || '').trim()).filter((t) => t.length >= 8))]
/** Every string in `value`, with each secret's value replaced. */
export function scrub(value, secrets = []) {
  if (!secrets.length) return value
  if (typeof value === 'string') return secrets.reduce((s, t) => s.split(t).join('[redacted]'), value)
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]))
  return value
}

const nullable = (schema) => (Array.isArray(schema?.type) ? schema.type : [schema?.type]).includes('null')
/**
 * `candidate` cut to `schema` by value: each key the schema does not name is gone; each value that does not fit is
 * dropped (optional), nulled (nullable), or — a required value that cannot be null — makes the whole thing null.
 * Arrays drop the items that do not fit. The result fits `schema`, or is null.
 */
export function cutTo(schema, candidate) {
  const out = {}
  for (const [k, v] of Object.entries(candidate)) {
    const sub = schema.properties?.[k]
    if (!sub || v === undefined) continue
    let value = v
    if (Array.isArray(value) && sub.items) value = value.filter((x) => fits(sub.items, x))
    if (fits(sub, value)) out[k] = value
    else if ((schema.required || []).includes(k)) {
      if (!nullable(sub)) return null
      out[k] = null
    }
  }
  return fits(schema, out) ? out : null
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
/**
 * A string from the Worker, the bearer cut out FIRST and only then cut to `max` — the other way round, a token
 * straddling the cut lost its tail to the slice and kept its head past the scrub (confirmation review 4).
 */
const strOf = (secrets) => (v, max) => (typeof v === 'string' ? scrub(v, secrets).slice(0, max) : v === null ? null : undefined)

/** One "Based on" entry: what the Worker read (or named and did not read), as a reference and a label. */
function basedOnEntry(v, str) {
  const b = obj(v) || {}
  return { ref: str(b.ref, 300), label: str(b.label, 300), read: b.read, rows: b.rows, version: str(b.version, 40), note: str(b.note, 300) }
}
const withoutUndefined = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) : o)

/**
 * A 200's body cut to the contract, or null when it is not an answer — then the sidecar says so (bad_answer). Keys the
 * schema does not name stay on the Worker; values it does not allow are dropped, nulled, or refuse the answer.
 */
export function normaliseAnswer(body, { secrets = [] } = {}) {
  const b = obj(body)
  if (!b || typeof b.answer !== 'string' || !b.answer.trim()) return null
  const str = strOf(secrets)
  const usage = obj(b.usage)
  const ledger = obj(b.ledger)
  const candidate = scrub(
    {
      answer: str(b.answer, 20_000),
      based_on: (Array.isArray(b.based_on) ? b.based_on : []).slice(0, 40).map((e) => withoutUndefined(basedOnEntry(e, str))),
      run_id: str(b.run_id, 64),
      model: str(b.model, 120),
      provider: str(b.provider, 40),
      usage: usage ? withoutUndefined({ input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }) : b.usage,
      tokens_in: b.tokens_in,
      tokens_out: b.tokens_out,
      truncated: b.truncated === true,
      ledger: ledger ? withoutUndefined({ run_started: ledger.run_started, run_completed: ledger.run_completed, run_failed: ledger.run_failed, row: str(ledger.row, 40) }) : b.ledger,
      ...(b.refused === true ? { refused: true, reason: str(b.reason, 40), ...(b.withheld === true ? { withheld: true } : {}) } : {}),
    },
    secrets,
  )
  return cutTo(SCHEMA, candidate)
}

/** An error's body cut to the contract: the Worker's code and sentence, the PA's run id when it has one, the wait on a 429. */
export function normaliseError(status, body, retryAfter = null, { secrets = [] } = {}) {
  const b = obj(body) || {}
  const str = strOf(secrets)
  const candidate = scrub(
    {
      error: str(b.error, 80),
      detail: str(b.detail, 1000),
      run_id: str(b.run_id, 64),
      provider: str(b.provider, 40),
      model: str(b.model, 120),
      ...(status === 429 ? { retry_after: retryAfter ?? undefined, asks_today: b.asks_today, tokens_today: b.tokens_today, limit: b.limit, token_limit: b.token_limit } : {}),
    },
    secrets,
  )
  for (const k of Object.keys(candidate)) if (candidate[k] === null) delete candidate[k] // an error carries no nulls
  const cut = cutTo(ERROR_SCHEMA, candidate)
  return cut || cutTo(ERROR_SCHEMA, { ...candidate, error: `http_${status}` }) || { error: `http_${status}` }
}

/** Retry-After as whole seconds: a number of seconds, or an HTTP date from now; null when it is neither. */
export function retryAfterOf(value, now = Date.now()) {
  const v = String(value ?? '').trim()
  if (/^\d+$/.test(v)) return Number(v)
  const at = Date.parse(v)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

// ─── The backstop: an answer that names a person (Annex III; review 5, 2026-10-05) ──────────
//
// The panel shows the Worker's answer as it comes. The Worker's own answer check misses some judgements of people by
// design (docs/ask.md "What it still misses": "Ann has the most open gates", a lone figure with no act named, names in
// lower case). So, as a backstop, the world withholds an answer that names someone the last ledger scan names as an
// actor — exact word or phrase matches only — and shows "Withheld: it named a person", with no text. The names never
// leave the server: the page holds no actor (Annex III), and nothing here logs one.

/**
 * Actors that are systems, not people — what the hooks, the Worker, the PA, the sweeps, the coordinator and the seed
 * write, and the live capture's scrubbed placeholder ("actor"). Fixed here, and anything starting "zztest" (the test
 * prefix) besides. Decided 2026-10-05 (confirmation review): the backstop ignores non-person actors, so "the Cowork
 * job", "Agent World" or "Actor fields" are words, not names.
 */
export const SYSTEM_ACTORS = Object.freeze([
  'world', 'cowork', 'worker', 'cron', 'coordinator', 'n8n', 'zapier', 'claude', 'hook', 'session_hook', 'system', 'actor',
  'claude_code', 'claude-code', 'cowork_scheduled', 'cowork_manual', 'sweep', 'poller', 'hooks', 'scheduler', 'make', 'github', 'ci', 'bot', 'agent', 'unknown', 'none', 'null',
])
const LETTER = /\p{L}/u

/** The trigger values the Worker accepts on an event (tellefsen-compass-mcp src/lib/events-endpoint.ts TRIGGERS) — fixed, never read from events. */
export const TRIGGERS = Object.freeze(['chat', 'claude_project', 'cowork_scheduled', 'cowork_manual', 'claude_code', 'session_hook'])

/**
 * The names the world already knows, from the substrate ONLY (review of ed7aba9, 2026-10-05): Active ops_clients,
 * ops_skills, WORLD_COMPANIES names and keys, the pack's rooms (names and ids), and the campus. Never from ledger
 * events or rows — anyone holding the events bearer can write one, and an honest event can carry a person's name in
 * `client`; the Worker draws the same line (its docs/ask.md: known names never come from events or ledger rows).
 * Towns and planets need no entry of their own: a town is an Active client, a planet a company. A name only events
 * vouch for — an inactive client, say — is not known, so an answer naming it is withheld: the safe side.
 */
export function substrateNames(substrate, { rooms = [], campus = '' } = {}) {
  const s = substrate && typeof substrate === 'object' ? substrate : {}
  const list = (v) => (Array.isArray(v) ? v : [])
  const text = (v) => (typeof v === 'string' && v.trim() ? [v.trim()] : [])
  const clients = list(s.clients).filter((c) => /^active$/i.test(String(c?.status || '').trim())).flatMap((c) => text(c?.name))
  const skills = list(s.skills).flatMap((k) => text(k?.name))
  const companies = list(s.world_companies?.companies).flatMap((c) => [...text(c?.name), ...text(c?.key)])
  const roomNames = list(rooms).flatMap((r) => [...text(r?.name), ...text(r?.id)])
  return { skills, clients, terms: [...companies, ...roomNames, ...text(campus)] }
}

/**
 * The actor values that may be people. Skipped: a system actor (SYSTEM_ACTORS, or a value starting "zztest"); a value
 * equal to a name the world already knows — a skill or one of its steps (`skill:step`, the approval layer's
 * proposers), a trigger value, a client or town, a place, or another substrate term (companies and their keys, rooms,
 * the campus); one with fewer than two letters. Compared without case. Trimmed, de-duplicated, longest first.
 */
export function personNames(actors = [], { skills = [], places = [], triggers = [], clients = [], terms = [] } = {}) {
  const lower = (v) => String(v || '').trim().toLowerCase()
  const system = new Set(SYSTEM_ACTORS)
  const skillSet = new Set(skills.map(lower).filter(Boolean))
  const knownSet = new Set([...skillSet, ...[...places, ...triggers, ...clients, ...terms].map(lower).filter(Boolean)])
  const out = new Map()
  for (const a of actors) {
    const name = String(a ?? '').trim()
    const key = name.toLowerCase()
    if (name.length < 2 || name.length > 200 || [...name].filter((c) => LETTER.test(c)).length < 2) continue
    if (system.has(key) || key.startsWith('zztest') || knownSet.has(key) || [...skillSet].some((k) => key.startsWith(`${k}:`))) continue
    if (!out.has(key)) out.set(key, name) // the first spelling seen; matching is by the rules below, not by case
  }
  return [...out.values()].sort((a, b) => b.length - a.length)
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * Whether `text` names one of `names`, as a whole word or phrase: no letter, digit or underscore either side.
 * A phrase (two words or more), an e-mail or a handle with a digit or punctuation matches in any case; a single plain
 * word matches only where it is capitalised, as a name is in prose ("Ann" or "ANN" for actor "ann" or "Ann"; never
 * "ann" in lower case, never "planned") — so a person called Will does not withhold every "will" in English. The
 * price: a lower-case name is missed, as the Worker's own check misses it, and "Will this run finish?" is withheld.
 */
export function namesPerson(text, names = []) {
  const t = String(text ?? '')
  if (!t) return false
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}_])`, 'giu')
    const plainWord = /^\p{L}+$/u.test(name)
    for (const m of t.matchAll(re)) {
      if (!plainWord || /^\p{Lu}/u.test(m[0])) return true
    }
  }
  return false
}

/** What the panel gets instead of an answer that named a person: the run, the model and the counts — no text, no refs. */
export function withheldForPerson(answer) {
  return {
    answer: 'Withheld: it named a person.',
    based_on: [],
    run_id: answer.run_id,
    model: answer.model,
    provider: answer.provider,
    usage: answer.usage,
    tokens_in: answer.tokens_in,
    tokens_out: answer.tokens_out,
    truncated: false,
    ledger: answer.ledger,
    refused: true,
    reason: 'named_person',
    withheld: true,
  }
}

// ─── The forwarder ───────────────────────────────────────────────────────────────────────────

/**
 * ask(body) → { status, body, headers }: the Worker's status and its body cut to the contract, or one of the sidecar's
 * own answers — 400 a body the Worker would refuse (never sent) · 409 a question already in flight · 503
 * world_not_configured (no /ask URL or no bearer on this machine) · 504 worker_timeout · 502 worker_unreachable · 502
 * bad_answer (a 200 that is not an answer).
 */
export function createAsk(cfg, { fetchImpl: rawFetch = globalThis.fetch, log = () => {}, now = Date.now, knownNames = () => [] } = {}) {
  const fetchImpl = withTimeout(rawFetch, cfg.askTimeoutMs ?? ASK_TIMEOUT_MS)
  const after = `${Math.round((cfg.askTimeoutMs ?? ASK_TIMEOUT_MS) / 1000)} s`
  /** Nit 7: whatever the Worker sends back, neither bearer's value is passed on. */
  const secrets = secretsOf(cfg.askBearerToken, cfg.eventsBearerToken)
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
      const what = status === 200 ? (out.reason === 'named_person' ? 'withheld (named a person)' : out.refused ? 'refused' : 'answered') : out.error
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
          ? done(504, { error: 'worker_timeout', detail: `The Worker did not answer within ${after}. The ask may still be running there; if it is, the Worker records it as its own run.` })
          : done(502, { error: 'worker_unreachable', detail: 'The Worker could not be reached from this machine.' })
      }
      let payload = null
      try {
        payload = await res.json()
      } catch (err) {
        if (err?.name === 'TimeoutError') return done(504, { error: 'worker_timeout', detail: `The Worker did not finish its answer within ${after}. The ask may still be running there; if it is, the Worker records it as its own run.` })
        payload = null // an error page that is not JSON: the status speaks for it
      }
      if (res.status === 200) {
        const answer = normaliseAnswer(payload, { secrets })
        if (!answer) return done(502, { error: 'bad_answer', detail: 'The Worker answered 200 without an answer in the shape spec/ask.v1.json names.' })
        // the backstop: an answer (not a refusal) that names someone the ledger names is withheld here, text and refs alike
        if (!answer.refused) {
          let names = []
          try {
            names = knownNames() || []
          } catch {
            names = []
          }
          if (namesPerson([answer.answer, ...answer.based_on.map((b) => b.label)].join('\n'), names)) return done(200, withheldForPerson(answer))
        }
        return done(200, answer)
      }
      const status = Number.isInteger(res.status) && res.status >= 400 && res.status <= 599 ? res.status : 502
      const retryAfter = status === 429 ? retryAfterOf(res.headers?.get?.('retry-after'), now()) : null
      return done(status, normaliseError(status, payload, retryAfter, { secrets }), retryAfter !== null ? { 'Retry-After': String(retryAfter) } : {})
    } finally {
      inFlight = false
    }
  }

  return { ask, inFlight: () => inFlight }
}
