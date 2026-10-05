// overlay/intray.mjs — the in-tray (U14): one list of every open ?, in the order N walks them.
// Pure: no DOM, no fetch — node runs it under npm test. The panel and the keys are in overlay/main.js.
//
// One data path. Rows come from the same threads the badges are drawn from (window.botCrossing.threads,
// the adapter's scan) — nothing is read twice, nothing is stored. A row is a thread whose figure wears
// a ? on the map, which is Bot Crossing's own precedence (src/game/colony.js statusFor): a failed run
// is ! not ?, a running one ⚒, then `unread` is the ?. Order (ES-4.4): badge precedence — every row is
// a ? — then the oldest open gate first (`gateAt` from the adapter), ties by run id. N takes the row
// after the selected one and wraps, so N and the list never disagree.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** Bot Crossing's precedence for a `?`: the same first-match order as statusFor, minus the states a Compass run never has. */
export const wearsQuestion = (t) => Boolean(t && !t.hasError && !t.running && t.prState !== 'MERGED' && t.unread)
/** A ! of its own (M2b): a request thread that failed — the still map's ! stands in the tray too (ES-6.1: the tray lists exactly the request threads). */
export const wearsAlert = (t) => Boolean(t && t.kind === 'request' && t.hasError)
/** A row is a ? of its own: a parent that only inherits a child's ? (U18) is not listed — N lands on the child. A fixture is never a row. */
const ownQuestion = (t) => t?.kind !== 'fixture' && wearsQuestion(t) && !t.inheritedGate
const isRow = (t) => ownQuestion(t) || wearsAlert(t)

/**
 * The gate a request is about: the oldest one the viewer can tap, else the oldest — a gate someone else must tap never
 * sets the row's age. The adapter picks the same gate for the title, the tag, the preview and Open (compass/threads.mjs
 * askedGate), so the row, the panel and the card always name one gate (confirmation 4, 2026-10-06).
 */
export function askedGateOf(t) {
  const all = (Array.isArray(t?.gates) ? t.gates : []).filter(Boolean)
  const mine = all.filter((g) => g.canTap !== false)
  const pool = mine.length ? mine : all
  return pool.length ? [...pool].sort((a, b) => num(a.at) - num(b.at))[0] : null
}

/** The rows, in N's order. */
export function intrayRows(threads) {
  const list = (Array.isArray(threads) ? threads : []).filter(isRow)
  return list
    .map((t) => {
      // M2b: a request's title is badge · verb · surface; the skill rides on `skill`. Older shapes split the title.
      const skill = t.skill || String(t.title || '').split(' · ')[0]
      // The oldest gate the viewer can tap (the ? is theirs); a gate someone else must tap never sets the row's age.
      const gate = askedGateOf(t)
      const alert = wearsAlert(t) && !wearsQuestion(t)
      if (alert) {
        return { id: t.id, badge: '!', skill: skill || 'Untitled run', zone: t.project || '', gate: '', surface: '', what: t.gitBranch || 'failed', url: t.ref?.url || '', at: num(t.lastActivityAt), left: 0 }
      }
      return {
        id: t.id,
        badge: '?',
        skill: skill || 'Untitled run',
        zone: t.project || '',
        gate: gate?.gate || String(t.title || '').split(' · ').slice(1).join(' · '),
        surface: gate?.surface || '',
        what: gate?.what || t.gitBranch || '',
        // the row's own gate's surface — a run can leave several gates; Open goes to this same gate (askedGateOf); a
        // session gate has no surface of its own, so it takes the run's link (the Claude Project or the terminal).
        // An approval-layer gate carries its own link (its proposal in the Compass console, from the adapter): Approve
        // opens that proposal or nothing, never another link the run happens to carry.
        url: gate?.surface === 'approval' ? gate.url || '' : (gate && gate.surface !== 'class_b_gate' && gate.ref_url) || t.ref?.url || '',
        // the oldest open gate; a thread whose adapter predates U14 falls back to its last activity
        at: num(gate?.at) || num(t.gateAt) || num(t.lastActivityAt),
        left: Array.isArray(t.gates) ? t.gates.length : 1,
      }
    })
    // badge precedence first (! before ?, as the renderer's STATUS_ORDER), then the oldest first, ties by id
    .sort((a, b) => (a.badge === b.badge ? 0 : a.badge === '!' ? -1 : 1) || a.at - b.at || String(a.id).localeCompare(String(b.id)))
}

/** The count the adapter puts after a gate's name on a run with several gates: "<gate> (n of m left) — …". */
const LEFT = /^ \(\d+ of \d+ left\) — /
/**
 * What the selection panel's "What it wants from you" names (overlay/main.js): the gate, and the full instruction the
 * adapter's preview gives after "<gate> — " (or "<gate> (n of m left) — " on a run with several gates). A request names
 * the gate it is about, askedGateOf — the one the adapter built the preview from — so the panel never pairs one gate's
 * name with another's instruction (confirmation 4), and on a mixed run the client reads their own gate (review,
 * 2026-10-06). A thread of the older shape names its gate in the title, after the skill.
 */
export function panelAsk(thread) {
  const gate = thread?.kind === 'request'
    ? String(askedGateOf(thread)?.gate || '')
    : String(thread?.title || '').split(' · ').slice(1).join(' · ')
  const preview = String(thread?.preview || '')
  if (!gate || !preview.startsWith(gate)) return { gate, instruction: '' }
  const rest = preview.slice(gate.length)
  const head = rest.startsWith(' — ') ? 3 : (LEFT.exec(rest)?.[0].length || 0)
  return { gate, instruction: head ? rest.slice(head) : '' }
}

/**
 * A sub-run's line in its parent's panel (overlay/main.js): failed, then waiting on you (with what to do), then
 * working, then waiting on someone else — with no gate detail, since the adapter sends none (`waiting`, set on the
 * server) — else done. Before 2026-10-06 a sub-run waiting on a gate this viewer cannot tap read "done".
 */
export function subrunState(s) {
  if (!s || typeof s !== 'object') return ''
  if (s.hasError) return '! failed'
  if (s.unread) return `? ${s.gitBranch || 'waiting on you'}`
  if (s.running) return '⚒ working'
  if (s.waiting) return 'waiting · not yours to tap'
  return 'done'
}

/**
 * U33 (ES-6.8): the hand-raise as a tray line. A skill silent 30 d that the pack wants (its override names a wants value
 * an Active project's Tech Stack contains) is a dusty row in its room panel and a lowest-precedence line here — never a
 * figure, so N never lands on it. `dusty` are the sidecar's dusty skill rows: [{ name, room, wants }].
 */
export function handLines(dusty) {
  return (Array.isArray(dusty) ? dusty : [])
    .filter((d) => d && d.name)
    .map((d) => ({ id: `hand:${d.name}`, badge: '✋', skill: d.name, zone: d.room || '', gate: '', surface: '', what: `silent 30 d and wanted${d.wants ? ' — ' + d.wants + ' is in an Active project\'s stack' : ''}`, url: '', at: 0, left: 0, hand: true }))
    .sort((a, b) => a.skill.localeCompare(b.skill))
}
/** The tray with the hand lines after every request: N walks `rows` only (nextRow is fed the request rows). */
export const withHands = (rows, dusty) => [...rows, ...handLines(dusty)]

/** The row N lands on: the one after `selectedId` in the list, wrapping; the first when nothing (or something else) is selected. */
export function nextRow(rows, selectedId) {
  if (!rows.length) return null
  const i = rows.findIndex((r) => r.id === selectedId)
  return rows[(i + 1) % rows.length]
}
