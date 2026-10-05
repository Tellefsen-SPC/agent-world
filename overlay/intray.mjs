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

/** The rows, in N's order. */
export function intrayRows(threads) {
  const list = (Array.isArray(threads) ? threads : []).filter(isRow)
  return list
    .map((t) => {
      // M2b: a request's title is badge · verb · surface; the skill rides on `skill`. Older shapes split the title.
      const skill = t.skill || String(t.title || '').split(' · ')[0]
      // The oldest gate the viewer can tap (the ? is theirs); a gate someone else must tap never sets the row's age.
      const all = Array.isArray(t.gates) ? t.gates : []
      const mine = all.filter((g) => g.canTap !== false)
      const gate = (mine.length ? mine : all).length ? [...(mine.length ? mine : all)].sort((a, b) => num(a.at) - num(b.at))[0] : null
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
        // the row's own gate's surface — a run can leave several gates and Open (U5) goes to the newest; a
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

/**
 * What the selection panel's "What it wants from you" names (overlay/main.js): the gate, and the full instruction when
 * the adapter's preview starts with "<gate> — ". A request names the first gate this viewer can tap, else its first —
 * the rule compass/still.mjs titles a request by — so on a run with the client's own gate and a proposal the client
 * reads their gate, never the blank entry an approval gate they cannot tap leaves in `gates` (review, 2026-10-06). A
 * thread of the older shape names its gate in the title, after the skill.
 */
export function panelAsk(thread) {
  const gates = Array.isArray(thread?.gates) ? thread.gates : []
  const gate = thread?.kind === 'request'
    ? String((gates.find((g) => g?.canTap) || gates[0])?.gate || '')
    : String(thread?.title || '').split(' · ').slice(1).join(' · ')
  const preview = String(thread?.preview || '')
  return { gate, instruction: gate && preview.startsWith(gate + ' — ') ? preview.slice(gate.length + 3) : '' }
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
