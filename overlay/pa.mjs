// overlay/pa.mjs — the PA panel's rules (U16, ES-4.6). Pure; node runs it under npm test.
//
// The panel asks the PA a question about the selected run, its town, a project's milestone, or the whole firm, and
// shows the answer with what it was based on. The question goes to the sidecar's POST /ask (overlay/zones.mjs askPa)
// and nowhere else; the sidecar adds the bearer (docs/adr/0008), so nothing here or in main.js ever holds one.
//
//   who            only a viewer holding `ask` (the Owner) sees the panel; everyone else gets nothing — no button, no
//                  key, no empty box (the sidecar refuses them too)
//   about what     places, a run, a project, a milestone, the firm: the subjects are built from the selection and the
//                  town card. There is no subject for a person, the placeholder and the suggestions ask about places
//                  and runs, and the context never carries an actor (Annex III; the Worker refuses person questions)
//   what it says   each status in plain words: an answer, a refusal, the PA not switched on, the day's budget spent
//                  (with the wait), the provider or the substrate failing — never a bare status code
//
// Nothing here stores, counts or writes anything.

export const MAX_QUESTION = 1000
export const MAX_PLACE = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export const PLACEHOLDER = 'Ask about this run, its town or a milestone: what is it waiting on? which gates are open here? what did it cost?'
export const HINT = 'Answers by place and by run, from the substrate. It never ranks, scores or compares people.'

/** The panel exists only for a viewer holding the `ask` capability (viewer.mjs: Owner). */
export const mayAsk = (viewer) => Array.isArray(viewer?.capabilities) && viewer.capabilities.includes('ask')

/** A place, project or milestone the Worker will take (≤ 200 characters, no quote, backslash or control), else ''. */
export function cleanText(v) {
  const t = String(v ?? '').trim()
  return t && t.length <= MAX_PLACE && !CONTROL.test(t) && !/["\\]/.test(t) ? t : ''
}

const SUGGEST = Object.freeze({
  run: ['What is this run waiting on?', 'What did this run produce?', 'What did this run cost?'],
  request: ['What is waiting here, and on which surface?', 'Which gates are open in this town?'],
  town: ['Which gates are open in this town?', 'What ran here this week?', 'What did this town cost this week?'],
  project: ['What is open on this project?', 'Which runs touched this project this week?'],
  milestone: ['Where does this milestone stand?', 'What is still open on this milestone?'],
  firm: ['Which towns have open gates?', 'What failed today?', 'What did the firm spend this week?'],
})
export const suggestionsFor = (kind) => SUGGEST[kind] || SUGGEST.firm

/**
 * What the panel can ask about, most specific first. `thread` is the selected figure's thread (or null), `town` the
 * open town card's name (or ''), `towns` the planet's town names, `noun` the pack's word for a town. Each subject is
 * { id, kind, label, context } — the context is exactly what the sidecar forwards: run_id, town, project, milestone.
 */
export function subjectsFor({ thread = null, town = '', towns = [], noun = 'town' } = {}) {
  const isTown = (name) => Boolean(name) && towns.includes(name)
  const out = []
  const add = (s) => {
    if (!out.some((o) => o.id === s.id)) out.push(s)
  }
  const townOf = (name) => (isTown(name) ? cleanText(name) : '')
  if (thread?.kind === 'request') {
    const place = townOf(thread.project)
    const skill = String(thread.skill || String(thread.title || '').split(' · ')[0] || 'run')
    if (UUID_RE.test(String(thread.id || ''))) {
      add({ id: `run:${String(thread.id).toLowerCase()}`, kind: 'run', label: `this run · ${skill}`, context: { run_id: String(thread.id).toLowerCase(), ...(place ? { town: place } : {}) } })
    } else if (place) {
      add({ id: `request:${thread.id}`, kind: 'request', label: `what waits here · ${skill}`, context: { town: place } })
    }
    if (place) add({ id: `town:${place}`, kind: 'town', label: `${noun} · ${place}`, context: { town: place } })
  } else if (thread?.kind === 'fixture' && thread.fixture === 'project') {
    const place = townOf(thread.project)
    const project = cleanText(thread.title)
    const base = { ...(project ? { project } : {}), ...(place ? { town: place } : {}) }
    add({ id: `project:${thread.id}`, kind: 'project', label: `project · ${thread.title || 'this project'}`, context: base })
    const ms = Array.isArray(thread.milestones) ? thread.milestones : []
    for (const m of [...ms.filter((x) => !x.done), ...ms.filter((x) => x.done)].slice(0, 6)) {
      const ref = cleanText(m.url) || cleanText(m.id) || cleanText(m.name)
      if (ref) add({ id: `milestone:${m.id || m.name}`, kind: 'milestone', label: `milestone · ${m.name || 'unnamed'}`, context: { ...base, milestone: ref } })
    }
    if (place) add({ id: `town:${place}`, kind: 'town', label: `${noun} · ${place}`, context: { town: place } })
  }
  const card = townOf(town)
  if (card) add({ id: `town:${card}`, kind: 'town', label: `${noun} · ${card}`, context: { town: card } })
  add({ id: 'firm', kind: 'firm', label: 'the whole firm', context: {} })
  return out
}

/** The subject in hand: the one chosen if it still exists, else the most specific. */
export const pickSubject = (subjects, id) => subjects.find((s) => s.id === id) || subjects[0] || null

/** '' when the question can go, else why not — the same bounds the sidecar and the Worker apply. */
export function questionProblem(text) {
  const q = String(text ?? '').trim()
  if (!q) return 'Type a question first.'
  if (q.length > MAX_QUESTION) return `At most ${MAX_QUESTION} characters (${q.length} now).`
  if (CONTROL.test(q)) return 'The question has a control character in it.'
  return ''
}

/** The body for the sidecar's POST /ask. */
export const requestBody = (question, subject) => ({ question: String(question ?? '').trim(), context: { ...(subject?.context || {}) } })

// ─── the answer and every other status, in words ─────────────────────────────────────────────

/** Seconds as a wait a person reads: 40 s, 12 min, 4 h 12 min. */
export function formatWait(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

/** The answer without its trailing "Based on: …" paragraph (the panel lists based_on itself), and that line. */
export function splitBasedOn(answer) {
  const text = String(answer ?? '')
  const cut = text.lastIndexOf('\n\n')
  const tail = cut >= 0 ? text.slice(cut + 2) : ''
  return /^Based on:/.test(tail) ? { text: text.slice(0, cut).trimEnd(), line: tail } : { text, line: '' }
}

/** The based_on refs as rows: what was read, and what was named but not read (with why). At most 12, then a count. */
export function basedOnRows(list) {
  const rows = (Array.isArray(list) ? list : []).filter((b) => b && typeof b.label === 'string' && b.label)
  const shown = rows.slice(0, 12).map((b) => ({ label: b.label, ref: String(b.ref || ''), note: b.read === false ? b.note || 'named, not read' : '' }))
  return rows.length > 12 ? [...shown, { label: `and ${rows.length - 12} more`, ref: '', note: '' }] : shown
}

const short = (id) => String(id || '').slice(0, 8)
const n = (v) => (Number.isFinite(v) ? Number(v).toLocaleString('en') : '')

/** The line under an answer: the PA's own run and the model it came from, then its tokens. */
export function metaLine(body) {
  const b = body || {}
  const parts = []
  if (b.run_id) parts.push(`run ${short(b.run_id)}`)
  if (b.model) parts.push(String(b.model))
  if (Number.isFinite(b.tokens_in) && Number.isFinite(b.tokens_out)) parts.push(`${n(b.tokens_in)} in · ${n(b.tokens_out)} out`)
  return parts.join(' · ')
}

const WORKER_502 = Object.freeze({
  provider_failed: ['The model provider failed', 'Nothing was answered. The ask is recorded as a failed run.'],
  provider_timeout: ['The model did not answer in time', 'The Worker waits 25 s for the model. The ask is recorded as a failed run.'],
  provider_empty: ['The model gave no answer', 'It used its output budget without an answer. The ask is recorded as a failed run.'],
  substrate_unavailable: ['The Worker could not read the substrate', 'There was nothing to answer from, so the model was not called. The ask is recorded as a failed run.'],
  ledger_unavailable: ['The run ledger did not record the ask', 'Every ask is a governed run, so the model was not called and nothing was spent. Try again.'],
  budget_unavailable: ["The Worker could not check today's budget", 'Nothing was spent and nothing was recorded. Try again.'],
  worker_unreachable: ['The Worker could not be reached', 'This machine got no answer from the Compass Worker. Nothing was asked.'],
  bad_answer: ['The Worker answered in a shape the panel does not know', 'Nothing is shown rather than a guess.'],
})

/**
 * What the panel shows for a result { status, body } from askPa (status 0: the sidecar did not answer):
 * { tone: answer | refused | off | budget | error, title, text, detail, wait, basedOn, meta, notes }.
 */
export function viewOf(result) {
  const status = Number(result?.status) || 0
  const b = result?.body && typeof result.body === 'object' ? result.body : {}
  const v = (tone, title, text, extra = {}) => ({ tone, title, text, detail: '', wait: '', basedOn: [], meta: '', notes: [], ...extra })
  const detail = typeof b.detail === 'string' ? b.detail : ''
  if (status === 200 && b.refused) {
    const by = b.withheld ? 'The answer check withheld what the model wrote.' : b.model ? 'The model declined it.' : 'The question check refused it before any model was called; nothing was spent.'
    return v('refused', 'Not answered: the PA does not judge people (Annex III)', String(b.answer || ''), { detail: by, meta: metaLine(b) })
  }
  if (status === 200) {
    const { text } = splitBasedOn(b.answer)
    const notes = []
    if (b.truncated) notes.push('Cut to fit: the substrate or the answer reached its limit.')
    if (b.ledger && b.ledger.run_completed === false) notes.push("The ledger missed this ask's end; it is still an answer.")
    return v('answer', 'Answer', text, { basedOn: basedOnRows(b.based_on), meta: metaLine(b), notes })
  }
  if (status === 0) return v('off', 'The side port did not answer', 'The question did not leave this machine. Is ./dev.sh running?')
  if (status === 429) {
    const wait = Number.isFinite(b.retry_after) ? `Try again in ${formatWait(b.retry_after)}: the budget resets at 00:00 UTC (04:00 Muscat).` : 'The budget resets at 00:00 UTC (04:00 Muscat).'
    return v('budget', "The PA's budget for today is spent", 'No model was called for this question, and nothing was recorded.', { detail, wait })
  }
  if (b.error === 'world_not_configured') return v('off', 'PA not switched on on this machine', detail || "The Worker's address or token is missing from .env.")
  if (status === 503 || b.error === 'ask_not_configured') return v('off', 'PA not switched on', 'The Worker has the route, but no model to call yet.', { detail })
  if (status === 404) return v('off', 'PA not switched on', 'The Worker has no /ask route yet: U16W is not deployed.')
  if (status === 401) return v('error', "The Worker refused this machine's token", 'The PA token in .env does not match the Worker (RUNBOOK §6). Fix it, then restart ./dev.sh.')
  if (status === 403) return v('off', String(b.error || 'Not allowed'), 'The PA answers the Owner only, from the page on this machine.')
  if (status === 409) return v('error', 'One question at a time', detail || 'The last question is still being answered.')
  if (status === 413) return v('error', 'The question is too long', `At most ${MAX_QUESTION} characters, and the whole request at most 8 KB.`)
  if (status === 400) return v('error', 'The question was not accepted', String(b.error || 'The request was malformed.'))
  if (status === 504) return v('error', 'The Worker did not answer in time', detail || 'Nothing came back before the deadline.')
  const known = WORKER_502[b.error]
  if (known) return v('error', known[0], known[1], { detail, meta: b.run_id ? `run ${short(b.run_id)}${b.model ? ` · ${b.model}` : ''}` : '' })
  return v('error', `The ask failed (HTTP ${status})`, String(b.error || 'No reason was given.'), { detail })
}

// ─── the panel's state ───────────────────────────────────────────────────────────────────────

export const initialPa = () => Object.freeze({ open: false, subjectId: '', question: '', pending: false, result: null, askedAbout: '' })

/**
 * The panel's state, one action at a time. 'send' starts an ask only when none is pending and the question can go;
 * the answer it gets is shown with the subject it was asked about, whatever is selected by the time it arrives.
 */
export function paReduce(state, action) {
  const s = state || initialPa()
  switch (action?.type) {
    case 'open':
      return { ...s, open: true, subjectId: action.subjectId ?? s.subjectId }
    case 'close':
      return { ...s, open: false }
    case 'toggle':
      return { ...s, open: !s.open }
    case 'subject':
      return { ...s, subjectId: String(action.id || '') }
    case 'type':
      return { ...s, question: String(action.text ?? '').slice(0, MAX_QUESTION + 200) }
    case 'send':
      if (s.pending || questionProblem(s.question) || !action.subject) return s
      return { ...s, pending: true, result: null, askedAbout: action.subject.label }
    case 'result':
      return s.pending ? { ...s, pending: false, result: { status: Number(action.status) || 0, body: action.body || {} } } : s
    default:
      return s
  }
}

/**
 * Everything the panel draws, or null — null for any viewer without `ask`, so another preset gets no element at all.
 */
export function panelModel({ viewer, state, subjects }) {
  if (!mayAsk(viewer) || !state?.open) return null
  const subject = pickSubject(subjects || [], state.subjectId)
  const problem = questionProblem(state.question)
  return {
    subjects: (subjects || []).map((s) => ({ id: s.id, label: s.label, pressed: s.id === subject?.id })),
    subject,
    placeholder: PLACEHOLDER,
    hint: HINT,
    suggestions: suggestionsFor(subject?.kind),
    count: `${String(state.question || '').trim().length}/${MAX_QUESTION}`,
    canSend: !state.pending && !problem && Boolean(subject),
    problem: String(state.question || '').trim() ? problem : '',
    sendLabel: state.pending ? 'Asking…' : 'Ask',
    pending: state.pending,
    askedAbout: state.askedAbout,
    view: state.result ? viewOf(state.result) : null,
  }
}
