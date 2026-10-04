// overlay/signals.mjs — the signals' presentation rules (U17). Pure; node runs it under npm test.
//
//   suit colour   one colour per run_mode under AUTO_RUN_POLICY, grey for unknown — the trust table, nowhere else
//   sound         a cue on a NEW ? or a NEW ! only: the diff between two rosters, never a poll's whole state
//   mute          the off-state is a render setting (settings key AW_MUTED), saved in the colony file beside render scale
// The facts themselves (trust, hand, flag, ✓) come from the adapter; nothing here reads a person.

/** run_mode → suit colour (hex), and the words the card uses. */
export const SUIT = Object.freeze({
  human_gated: { hex: 0xd9a441, label: 'human-gated', hint: 'Class B under AUTO_RUN_POLICY: a human judges before it acts' },
  unattended_allowed: { hex: 0x3fa7a0, label: 'unattended allowed', hint: 'Class A under AUTO_RUN_POLICY: gather, sync, check, propose' },
  unknown: { hex: 0x8b8b85, label: 'trust unknown', hint: 'no run_mode from AUTO_RUN_POLICY and no run_class on the run' },
})
export const suitFor = (trust) => SUIT[trust?.mode] || SUIT.unknown

/** The settings key the mute lives under — Bot Crossing keeps every settings value in the colony file's `settings`. */
export const AW_MUTED = 'awMuted'

const wearsQuestion = (t) => Boolean(t && !t.hasError && !t.running && t.unread)

/**
 * What is NEW since the last roster: ids that wear a ? now and did not before, ids that wear a ! now and did
 * not before. The first roster primes and reports nothing — the world opening is not an event.
 */
export class SignalDiff {
  constructor() {
    this.q = null
    this.x = null
  }
  update(threads) {
    const list = Array.isArray(threads) ? threads : []
    const q = new Set(list.filter(wearsQuestion).map((t) => t.id))
    const x = new Set(list.filter((t) => t?.hasError).map((t) => t.id))
    const out = { question: [], alert: [] }
    if (this.q) {
      for (const id of q) if (!this.q.has(id)) out.question.push(id)
      for (const id of x) if (!this.x.has(id)) out.alert.push(id)
    }
    this.q = q
    this.x = x
    return out
  }
}

/**
 * The bench: residents never take a figure from a run. Bot Crossing draws at most `maxAgents` figures and
 * cuts the roster in its own order (biggest plot first, oldest first), so a resident that reached the
 * page could stand while a live run was cut. The fetch seam applies this before the page sees the list:
 * every run stays; residents fill only what is left of the budget, by name, and go last.
 * @returns { threads, shown, total } — total = residents the adapter sent for this planet
 */
export function benchResidents(threads, maxAgents) {
  const list = Array.isArray(threads) ? threads : []
  const runs = list.filter((t) => !t?.resident)
  const residents = list.filter((t) => t?.resident).sort((a, b) => String(a.title).localeCompare(String(b.title)))
  const budget = Math.max(0, (Number(maxAgents) || 0) - runs.length)
  const shown = residents.slice(0, budget)
  return { threads: [...runs, ...shown], shown: shown.length, total: residents.length }
}

/**
 * U37 — the notice for a Compass that is not answering, or null when it is. Pure; the strip draws it as a pill.
 * `compass` is signals.compass from GET /world: { ok, downSince, lastGoodAt, error }. Until the first scan has
 * finished, ok is null and nothing is shown — a world that is still loading is not a world that is down.
 */
export function compassNotice(compass, { timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } = {}) {
  if (!compass || compass.ok !== false) return null
  const since = compass.downSince ? timeOf(compass.downSince) : null
  const seen = compass.lastGoodAt ? timeOf(compass.lastGoodAt) : null
  return {
    label: 'Compass unavailable',
    detail: since ? `since ${since}` : '',
    title: [
      `No answer from Compass${since ? ` since ${since}` : ''}${compass.error ? ` (${compass.error})` : ''}.`,
      seen ? `What you see is what the world last saw, at ${seen}.` : 'Nothing has loaded yet, so the world is empty.',
      'It keeps trying on its own; nothing here is lost.',
    ].join(' '),
  }
}
