// overlay/spend.mjs — spend per town and room (U35, ES-4.13). Pure: no DOM, no fetch — node runs it under npm test;
// overlay/main.js turns a place's bucket into the one line a town card or a room panel carries.
//
// The Worker's GET /world/spend (through the sidecar's /spend) prices ops_skill_runs against MODEL_PRICING and hands
// back rows by client, by skill and by client×skill. Nothing is counted here — the rows are folded into places:
//   town      the by_client row whose client is a town on the planet on screen
//   room      the by_skill rows — every client's — each through the pack's own roomForSkill (the rows carry
//             ops_skills.type): the same function that places a skill's agent in its home studio. A room's line is
//             what its skills spent wherever they ran (fixture Iota's skill, type Research, reads in the research lab).
//   campus    the "internal" client folded the same way — its by_client_skill rows into campusRooms — plus elsewhere:
//             what is on the home planet but in no town and no room (a client with no town anywhere — place() puts an
//             unknown client on the home planet; an internal row whose room the pack does not declare) — rendered,
//             never dropped. The home planet only; another planet has towns and nothing else.
//   planet    towns + campus
// The two identities the test proves, on cost_usd and runs_total: campusRooms + elsewhere = campus; towns + campus =
// planet. (rooms — every client's skills — is a second cut of the same runs, not a term of either identity.)
// Owner-only (Component 9): spendLineFor yields nothing — not a blank line — for any other viewer preset, and nothing
// under a pack whose spend.show is false (neutral). Never per person (Annex III): a bucket is a place, not anyone.
//
// U36 — the empty town and the estimate line. Every town of the planet gets a bucket, so a town with no by_client row
// (or one with runs_total 0) reads one quiet line, `no runs · 30d`, never a blank and never $0. A by_client row may
// carry est — the client's chat-usage estimate from SPEND_ESTIMATES (a claude.ai export attributed by name). It rides
// on the town's bucket as `est` and is shown on its own line under the metered one — `est. chat …` with a tilde —
// and is never summed into a counter: add() and sum() touch COUNTERS only, so a fold with est reads the same metered
// figures as one without. The campus and the planet carry totals.est. Pack-gated a second time: spend.estimates.
import { roomForSkill, roomsOf } from '../server/harnesses/compass/pack-rules.mjs'

export const COUNTERS = Object.freeze(['runs_total', 'runs_metered', 'runs_unmetered', 'runs_unpriced', 'tokens_in', 'tokens_out', 'tokens_unpriced', 'cost_usd'])
export const INTERNAL = 'internal'
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** An empty bucket — every counter the Worker's buckets carry, at zero. */
export const bucket = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]))
/** into += row, counter by counter (cost_usd kept to 4 dp, as the Worker keeps it). */
export function add(into, row) {
  for (const k of COUNTERS) into[k] = k === 'cost_usd' ? round4(into[k] + num(row?.[k])) : into[k] + num(row?.[k])
  return into
}
export const round4 = (n) => Math.round(n * 1e4) / 1e4
export const sum = (list) => [...list].reduce((acc, b) => add(acc, b), bucket())

/**
 * Fold the Worker's object into the places of one planet.
 * @param body    the sidecar's /spend (GET /world/spend)
 * @param pack    the World Pack the planet wears (its rooms and skills rule)
 * @param towns   world.towns — [{ name, planet }]
 * @param planet  the planet key on screen; home — the home planet's key (the campus lives there)
 */
export function foldSpend(body, { pack, towns = [], planet = '', home = '' } = {}) {
  const rooms = new Map(roomsOf(pack).map((r) => [r.id, bucket()]))
  const campusRooms = new Map(roomsOf(pack).map((r) => [r.id, bucket()]))
  const elsewhere = bucket()
  const townBuckets = new Map()
  const townPlanet = new Map((Array.isArray(towns) ? towns : []).filter((t) => str(t?.name)).map((t) => [str(t.name), str(t.planet)]))
  for (const [name, p] of townPlanet) if (p === planet) townBuckets.set(name, bucket()) // U36: every town here has a bucket, rows or not
  const onHome = !home || planet === home
  for (const row of Array.isArray(body?.by_client) ? body.by_client : []) {
    const client = str(row?.client)
    if (townPlanet.has(client)) {
      if (townPlanet.get(client) === planet) townBuckets.set(client, withEst(add(bucket(), row), row?.est))
    } else if (client !== INTERNAL && onHome) add(elsewhere, row) // no town anywhere: the home planet, outside every room
  }
  if (onHome) {
    for (const row of Array.isArray(body?.by_skill) ? body.by_skill : []) {
      const { room } = roomForSkill(pack, row?.skill, row?.type)
      add(rooms.get(room) || rooms.get(roomsOf(pack)[0]?.id) || elsewhere, row)
    }
    for (const row of Array.isArray(body?.by_client_skill) ? body.by_client_skill : []) {
      if (str(row?.client) !== INTERNAL) continue
      const { room } = roomForSkill(pack, row.skill, row.type)
      add(campusRooms.get(room) || elsewhere, row)
    }
  }
  // U36: the campus and the planet carry the Worker's own sum of the estimates (totals.est) when it is non-zero —
  // a separate figure beside the metered one, not a term of either identity
  const campus = withEst(add(sum(campusRooms.values()), elsewhere), nonZeroEst(body?.totals?.est))
  const planetBucket = withEst(add(sum(townBuckets.values()), campus), nonZeroEst(body?.totals?.est))
  return {
    window: body?.window_days ?? null,
    display: body?.display && typeof body.display === 'object' ? body.display : null,
    totals: body?.totals && typeof body.totals === 'object' ? body.totals : null,
    at: str(body?.at),
    error: str(body?.error),
    estimatesVersion: str(body?.estimates_version),
    onHome,
    towns: townBuckets,
    rooms,
    campusRooms,
    elsewhere,
    campus,
    planet: planetBucket,
  }
}

// ── U36: estimates ────────────────────────────────────────────────────────────────────────────

/** The est object as the Worker shaped it, or null — a copy, never the row. */
export const estOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : null)
/** An est worth a line: tokens or cost above zero. */
export const nonZeroEst = (v) => {
  const e = estOf(v)
  return e && num(e.tokens_in_est) + num(e.tokens_out_est) + num(e.cost_usd_est) > 0 ? e : null
}
/** Hang an est on a bucket without touching a counter; without one the bucket carries no est key at all. */
export function withEst(b, est) {
  const e = estOf(est)
  if (e) b.est = e
  return b
}

/** The two identities the test proves, on cost_usd and runs_total: campusRooms + elsewhere = campus; towns + campus = planet. */
export function reconcile(fold) {
  const eq = (a, b) => Math.abs(a - b) < 1e-6
  const rooms = add(sum(fold.campusRooms.values()), fold.elsewhere)
  const towns = add(sum(fold.towns.values()), fold.campus)
  return {
    roomsPlusElsewhereIsCampus: eq(rooms.cost_usd, fold.campus.cost_usd) && rooms.runs_total === fold.campus.runs_total,
    townsPlusCampusIsPlanet: eq(towns.cost_usd, fold.planet.cost_usd) && towns.runs_total === fold.planet.runs_total,
  }
}

// ── numbers ───────────────────────────────────────────────────────────────────────────────────

/** 84k, 1.2M, 327k, 9.5k — integers below a thousand. */
export function compact(n) {
  const v = num(n)
  const a = Math.abs(v)
  const trim = (s) => s.replace(/\.0$/, '')
  if (a < 1000) return String(Math.round(v))
  if (a < 10_000) return `${trim((v / 1e3).toFixed(1))}k`
  if (a < 1e6) return `${Math.round(v / 1e3)}k`
  if (a < 10e6) return `${trim((v / 1e6).toFixed(1))}M`
  if (a < 1e9) return `${Math.round(v / 1e6)}M`
  if (a < 10e9) return `${trim((v / 1e9).toFixed(1))}B` // U36: an estimate over a month runs to the hundreds of millions
  return `${Math.round(v / 1e9)}B`
}
/** A cost that would print as zero while it is not gets two more places. */
const fixed = (v, d) => {
  const s = v.toFixed(d)
  return v > 0 && Number(s) === 0 ? v.toFixed(d + 2) : s
}
/**
 * $18.40 for USD. OMR multiplies by display.omr_per_usd from the response at display time — the world holds no
 * peg; without one in the response the line stays in dollars.
 */
export function money(usd, { currency = 'USD', omrPerUsd = null } = {}) {
  const v = num(usd)
  const peg = Number(omrPerUsd)
  if (currency === 'OMR' && Number.isFinite(peg) && peg > 0) return `${fixed(v * peg, 3)} OMR`
  return `$${fixed(v, 2)}`
}
export const windowLabel = (w) => (w === 'all' ? 'all' : `${Number.isFinite(Number(w)) && w !== null ? w : '?'}d`)

/**
 * The line: `Tokens {in+out} · {cost} · {window}d`, then `· {unmetered} of {total} runs unmetered` when unmetered > 0
 * and `· {unpriced} unpriced` when unpriced > 0. With runs_metered = 0 the cost reads "unmetered", never $0.
 */
export function spendLine(b, { window = null, currency = 'USD', omrPerUsd = null } = {}) {
  if (!b || typeof b !== 'object') return ''
  const tokens = num(b.tokens_in) + num(b.tokens_out)
  const cost = num(b.runs_metered) > 0 ? money(b.cost_usd, { currency, omrPerUsd }) : 'unmetered'
  let line = `Tokens ${compact(tokens)} · ${cost} · ${windowLabel(window)}`
  if (num(b.runs_unmetered) > 0) line += ` · ${num(b.runs_unmetered)} of ${num(b.runs_total)} runs unmetered`
  if (num(b.runs_unpriced) > 0) line += ` · ${num(b.runs_unpriced)} unpriced`
  return line
}

/**
 * U36 — the estimate line: `est. chat {in+out} · ~{cost} · {start}–{end} · {n} conversations`; the word est. and the
 * tilde are what mark it an estimate. confidence medium adds `· attributed by name` (the export names the client, no
 * mapping proves it). A segment the est does not carry (totals.est has no period, no conversations) is left out.
 * Nothing here is a metered figure and nothing here is added to one.
 */
export function estLine(est, { currency = 'USD', omrPerUsd = null } = {}) {
  const e = estOf(est)
  if (!e) return ''
  const parts = [`est. chat ${compact(num(e.tokens_in_est) + num(e.tokens_out_est))}`, `~${money(e.cost_usd_est, { currency, omrPerUsd })}`]
  if (str(e.period_start) && str(e.period_end)) parts.push(`${str(e.period_start)}–${str(e.period_end)}`)
  if (Number.isInteger(e.conversations)) parts.push(`${e.conversations} conversation${e.conversations === 1 ? '' : 's'}`)
  if (str(e.confidence) === 'medium') parts.push('attributed by name')
  return parts.join(' · ')
}

/** Owner-only, and only under a pack that shows spend (tellefsen-campus yes, neutral no). */
export const showSpend = (viewer, pack) => viewer?.preset === 'owner' && pack?.spend?.show === true
/** U36: the estimate line needs the spend gate and the pack's spend.estimates as well. */
export const showEstimates = (viewer, pack) => showSpend(viewer, pack) && pack?.spend?.estimates === true
const lineOpts = (pack, fold) => ({ window: fold?.window ?? pack?.spend?.window_days ?? null, currency: str(pack?.spend?.currency) || 'USD', omrPerUsd: fold?.display?.omr_per_usd ?? null })

/** The line for a place under this viewer and pack — '' (nothing, not a blank line) when it is not shown. */
export function spendLineFor(b, { viewer, pack, fold } = {}) {
  if (!showSpend(viewer, pack) || !b) return ''
  return spendLine(b, lineOpts(pack, fold))
}

/** U36: the estimate line for a place (its bucket's est), or '' — under the Owner preset, a pack showing spend, and spend.estimates. */
export function estLineFor(b, { viewer, pack, fold } = {}) {
  if (!showEstimates(viewer, pack) || !b?.est) return ''
  return estLine(b.est, lineOpts(pack, fold))
}

/**
 * U36: the lines a town card carries, in order — never an empty list for the Owner under a spend-showing pack:
 *   no bucket, or runs_total 0 and no (shown) est   →  [`no runs · 30d`]
 *   runs_total 0 with an est                        →  [`no metered runs · 30d`, `est. chat …`]
 *   runs                                            →  [the metered line, unchanged], plus `est. chat …` when there is one
 * The metered line is spendLine's, byte for byte, est or no est: an estimate is never summed into it.
 */
export function townLines(b, { viewer, pack, fold } = {}) {
  if (!showSpend(viewer, pack)) return []
  const est = estLineFor(b, { viewer, pack, fold })
  const w = windowLabel(lineOpts(pack, fold).window)
  if (!b || num(b.runs_total) === 0) return est ? [`no metered runs · ${w}`, est] : [`no runs · ${w}`]
  return est ? [spendLine(b, lineOpts(pack, fold)), est] : [spendLine(b, lineOpts(pack, fold))]
}

/**
 * U37 — today's line on a town card, from the Worker's GET /ledger/cost?days=1 (Compass U5) through the sidecar's
 * /spend/today: the UTC day so far, priced by the same code as the 30-day line, the town's own by_town row.
 *   `Today · $1.23 · 4 runs`   `Today · unmetered · 2 runs`   `Today · no runs`   `Today · unavailable` (the read failed)
 * Under the same gate as every spend line — the Owner preset, a pack that shows spend — and never per person.
 */
export function todayRowFor(today, town) {
  const name = str(town)
  return (Array.isArray(today?.by_town) ? today.by_town : []).find((r) => str(r?.town) === name) || null
}
export function todayLine(row, { currency = 'USD', omrPerUsd = null } = {}) {
  const runs = num(row?.runs_total)
  if (!row || runs === 0) return 'Today · no runs'
  const cost = num(row.runs_metered) > 0 ? money(row.cost_usd, { currency, omrPerUsd }) : 'unmetered'
  let line = `Today · ${cost} · ${runs} run${runs === 1 ? '' : 's'}`
  if (num(row.runs_metered) > 0 && num(row.runs_unmetered) > 0) line += ` · ${num(row.runs_unmetered)} unmetered`
  return line
}
export function todayLineFor(today, town, { viewer, pack, fold } = {}) {
  if (!showSpend(viewer, pack) || !today) return ''
  if (today.error) return 'Today · unavailable'
  return todayLine(todayRowFor(today, town), lineOpts(pack, fold))
}

/** A plain object for the console handle and the checks (no Maps). */
export function summary(fold) {
  if (!fold) return null
  const plain = (m) => Object.fromEntries([...m.entries()])
  return { at: fold.at, window: fold.window, estimatesVersion: fold.estimatesVersion, onHome: fold.onHome, towns: plain(fold.towns), rooms: plain(fold.rooms), campusRooms: plain(fold.campusRooms), elsewhere: fold.elsewhere, campus: fold.campus, planet: fold.planet, totals: fold.totals, reconciled: reconcile(fold), error: fold.error }
}
