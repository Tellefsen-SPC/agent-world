/**
 * Run → Thread. The one place Tellefsen's ontology meets Bot Crossing's thread shape
 * (server/harnesses/README.md is the contract). Pure apart from the two awaited surface reads.
 */
import { openGates, normaliseArtifact } from './fold.mjs'
import { CAMPUS } from './config.mjs'

const STALE_MS = 3 * 24 * 60 * 60 * 1000 // the renderer's own sleep threshold, for reference only
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * The exact inverse of the renderer's transcriptProgress:
 *   progress = clamp((log10(sizeBytes) - 3) / 3.5, 0.05, 1)
 * so the card's bar reads done ÷ total. Nothing else in the renderer reads sizeBytes for size.
 */
export const sizeBytesForProgress = (p) => Math.round(10 ** (3 + 3.5 * clamp(Number(p) || 0, 0.05, 1)))
export const sizeBytesFor = (done, total) => sizeBytesForProgress(total > 0 ? clamp(done / total, 0.05, 1) : 0.05)

const newest = (list) => (list.length ? list.reduce((a, b) => (b.at >= a.at ? b : a)) : null)

/**
 * What the human has to do to clear a gate, by surface. Rendered on the card as a tag
 * (Bot Crossing shows `gitBranch` as a plain tag and never renders `preview`), so the card
 * answers "what does it want me to do?" instead of just "waiting on you". M2's in-tray
 * replaces this with a real card; at M1 this is the whole affordance.
 */
const WHAT_TO_DO = {
  // short: fits Bot Crossing's own card tag (it truncates past ~20 chars)
  // long: the overlay panel (overlay/main.js) renders this in full via `preview`
  pending_approval: ['approve in Airtable', 'A Pending Approval row is waiting. Open it in Airtable and set its Status to Approved or Rejected.'],
  decision: ['ratify in Notion', 'A proposed Decision is waiting. Open it in Notion and set Status to Active (ratify) or Superseded (reject).'],
  content_status: ['sign in Notion', 'A content draft is waiting for your signature. Open it in Notion, read it, and if it is right move Status from In Review to Scheduled. The ? clears within a poll.'],
  class_b_gate: ['answer in session', 'This run stopped to ask you something in the session that opened it. Open takes you to that session — answer there.'],
  client_gate: ["client's to tap", 'This acceptance is addressed to the client; it is theirs to tap, not yours.'],
  // Compass's approval layer (src/lib/approval): a proposal parked in `waiting`, decided in the Compass console
  approval: ['approve in Compass', 'A proposal is waiting for an approver. Open it in the Compass console and approve, edit or reject it.'],
}
/**
 * A class_b_gate is answered where the run lives, and that depends on what started it. Seen live
 * 2026-09-06: a build session's gate pointed at a Notion page and the human didn't know what to do
 * there — the answer belonged in the Claude Project chat.
 */
const SESSION_GATE = {
  claude_project: ['answer in the Claude Project', 'A Claude session in the Claude Project is waiting for your answer. Open it and reply with what you found — a sentence is enough. Nothing to change on a surface.'],
  chat: ['answer in the chat', 'The chat that started this run is waiting for your reply. Open it and answer there.'],
  claude_code: ['answer in the terminal', 'A Claude Code session stopped for a permission or a decision. Answer in the terminal where it is running.'],
  session_hook: ['answer in the terminal', 'A Claude Code session stopped for a permission or a decision. Answer in the terminal where it is running.'],
}
const pick = (gate, run) => {
  if (!gate) return ['', '']
  if (gate.surface === 'class_b_gate' && SESSION_GATE[run?.trigger]) return SESSION_GATE[run.trigger]
  return WHAT_TO_DO[gate.surface] || [`resolve: ${gate.gate}`, `Resolve the gate "${gate.gate}" on its surface.`]
}
export const whatToDo = (gate, run) => pick(gate, run)[0]
export const whatToDoLong = (gate, run) => pick(gate, run)[1]

/** What a failed run should say. Nothing waits on a human here; say so, and say where to retry. */
export function failedText(run, row) {
  const reason = run.failReason ? `: ${run.failReason}` : ' (no reason recorded)'
  const note = typeof row?.notes === 'string' ? row.notes.trim() : ''
  const notes = note && note !== run.failReason ? ` ${note}` : ''  // don't say the reason twice
  const where = { claude_project: 'the Claude Project', chat: 'the chat', claude_code: 'Claude Code', session_hook: 'Claude Code', cowork_scheduled: 'Cowork', cowork_manual: 'Cowork' }[run.trigger] || 'where it ran'
  return `Failed${reason}.${notes} Nothing in a surface is waiting on you — the Run Governance sweep records failures. To retry, start ${run.skill || 'the skill'} again from ${where}.`
}

/** Where Open should land, first match wins (SPEC.md §4.4). */
const isLink = (u) => typeof u === 'string' && /^https?:\/\//i.test(u)

/**
 * Every artifact the run left, from the events (artifact_registered, run_completed.artifacts) and the
 * ops_skill_runs row ([{ url, system }]) — one list, newest first, deduped (U13). Each row carries
 * `url` (a real link: Open lands there) or `ref` (a Compass reference: a label, not openable).
 */
export function artifactsOf(run, row) {
  const out = [...run.artifacts]
  for (const a of Array.isArray(row?.artifacts) ? row.artifacts : []) {
    const art = normaliseArtifact(a, run.lastAt)
    if (!art) continue
    const key = art.url || art.ref || art.title
    if (!out.some((x) => (x.url || x.ref || x.title) === key)) out.push(art)
  }
  return out.sort((a, b) => b.at - a.at).map(({ type, title, url, ref, system, at }) => ({ type, title, url, ref, system, at, openable: isLink(url) }))
}

/**
 * An approval-layer gate (Compass src/lib/approval; vendor/approval-layer `approvalGateName`) is named
 * approval:<proposal id>, and a proposal id is a uuid: minted by crypto.randomUUID on the Worker, kept in a uuid column,
 * matched by the Worker's /proposals/:id routes as 36 hex-and-dash characters. Only `approval:` exactly (the layer's
 * own word, in lower case) and the canonical 8-4-4-4-12 form are taken; the hex may be either case. Anything else —
 * no id, a path, markup, a space, a ? or #, a percent escape, a newline, `APPROVAL:` — gives no link, never a broken
 * or injected one.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const APPROVAL_GATE = new RegExp(`^approval:(${UUID})$`)
/** The console prefix exactly as config.mjs derives it from EVENTS_URL: https, no user, query or fragment, ending in /console/proposals. */
const CONSOLE_PREFIX = /^https:\/\/[^\s/?#@\\]+(?:\/[^\s?#@\\]*)?\/console\/proposals$/

/**
 * The proposal's page in the Compass approvals console: <worker base>/console/proposals/<proposal id>, the id
 * URL-encoded (a no-op for a uuid, kept so no character can ever reach the path raw) and lowercased (a uuid is
 * case-insensitive; the layer mints lowercase). Null for a malformed gate name or a prefix that is not config.mjs's.
 */
export function approvalConsoleUrl(gateName, consoleProposalsUrl) {
  const m = typeof gateName === 'string' ? APPROVAL_GATE.exec(gateName) : null
  if (!m || typeof consoleProposalsUrl !== 'string' || !CONSOLE_PREFIX.test(consoleProposalsUrl)) return null
  const url = `${consoleProposalsUrl}/${encodeURIComponent(m[1].toLowerCase())}`
  // Belt and braces: CONSOLE_PREFIX already rules out another scheme, a user, a query and a fragment, and config.mjs
  // builds the prefix from a parsed URL. What is left is a prefix of the right shape whose host or port the URL parser
  // refuses (`https://a<b/…`, `:99999`) — handed in by some other caller; it gives no link rather than a broken one.
  try {
    new URL(url)
  } catch {
    return null
  }
  return url
}

/**
 * Where one gate's Open goes. Its ref_url when that is a link — the rule for every gate. Else, for an approval-layer
 * gate, which carries its proposal id in its name rather than a ref_url, the proposal's page in the Compass console.
 * Else nothing.
 */
export function gateUrl(gate, { consoleProposalsUrl = '' } = {}) {
  if (isLink(gate?.ref_url)) return gate.ref_url
  if (gate?.surface === 'approval') return approvalConsoleUrl(gate.gate, consoleProposalsUrl) || ''
  return ''
}

export function openUrlFor(run, row, gatesOpen, { claudeProjectUrl = '', consoleProposalsUrl = '' } = {}) {
  // A class_b_gate on a run that lives in a Claude session opens that session — the answer goes
  // there, not on the page the gate happens to reference (that page becomes ref.context).
  const g0 = newest(gatesOpen)
  if (g0 && g0.surface === 'class_b_gate' && (run.trigger === 'claude_project' || run.trigger === 'chat') && isLink(claudeProjectUrl)) return claudeProjectUrl
  const gate = newest(gatesOpen)
  const link = gate ? gateUrl(gate, { consoleProposalsUrl }) : ''
  if (link) return link
  const art = newest(run.artifacts.filter((a) => isLink(a.notion_url)))
  if (art) return art.notion_url
  // Ledger artifacts may be Compass references (ops_config:KEY) — only a real link can be opened.
  const rowArts = Array.isArray(row?.artifacts) ? row.artifacts : []
  const first = rowArts.find((a) => a && isLink(a.url))
  if (first) return first.url
  if ((run.trigger === 'chat' || run.trigger === 'claude_project') && isLink(claudeProjectUrl)) return claudeProjectUrl
  return null
}

/**
 * Sub-agents (U18). Pure, after every thread exists:
 *   - a child (parent_run_id set, parent in the roster) stands where its parent stands — same zone, same
 *     planet (placed by the parent's client, never by actor) — and says so on its card
 *   - the parent lists its children ("n sub-runs") and inherits a waiting child's ? by precedence: a parent
 *     that is not itself ! shows ?; running is suspended while a child waits, as for its own gates. The ?
 *     is marked inherited so the in-tray and N land on the child, not the parent (ES-4.9)
 *   - a stream with no parent_run_id leaves every thread exactly as it was (the snapshot test)
 */
export function linkSubagents(threads, runs) {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const children = new Map() // parent id → [child threads]
  // the plot is the root ancestor's — a grandchild stands with the whole crew, whatever order the roster came in
  const rootOf = (id) => {
    let cur = id
    for (let hops = 0; hops < 8; hops++) {
      const up = runs.get(cur)?.parentId || ''
      if (!up || up === cur || !byId.has(up)) break
      cur = up
    }
    return byId.get(cur)
  }
  for (const t of threads) {
    const parentId = runs.get(t.id)?.parentId || ''
    if (!parentId || !byId.has(parentId) || parentId === t.id) continue
    const parent = byId.get(parentId)
    const root = rootOf(t.id)
    t.parentId = parentId
    t.parentTitle = parent.title.split(' · ')[0]
    t.project = root.project
    t.planet = root.planet
    t.pack = root.pack
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId).push(t)
  }
  for (const [parentId, kids] of children) {
    const parent = byId.get(parentId)
    parent.subruns = kids.map((k) => ({ id: k.id, title: k.title.split(' · ')[0], unread: k.unread, running: k.running, hasError: k.hasError, gitBranch: k.gitBranch }))
    // a child that failed wears ! on the map, not ? — nothing to inherit from it
    const waiting = kids.filter((k) => k.unread && !k.hasError)
    if (waiting.length && !parent.hasError && !parent.unread) {
      parent.unread = true
      parent.inheritedGate = true
      parent.running = false
      parent.title = `${parent.title.split(' · ')[0]} · ${waiting.length === 1 ? 'a sub-run waits' : waiting.length + ' sub-runs wait'}`
      parent.gitBranch = parent.gitBranch || 'a sub-run is waiting on you'
    }
  }
  return threads
}

export async function toThread(run, row, viewer, surfaces, now = Date.now(), opts = {}) {
  const runningTtlMs = opts.runningTtlMs ?? 2 * 3600 * 1000
  // Gates still open on their surface. A gate the surface already resolved (U6) is not pending.
  const open = openGates(run)
  const pending = []
  let unread = false
  for (const g of open) {
    if (await surfaces.gateResolved(g)) continue
    pending.push(g)
    // A ? only for a gate the viewer can resolve (D2, 2026-09-05); others see a quiet pose.
    if (viewer.canTap(g)) unread = true
  }

  const progress = run.project ? await surfaces.progress(run.project) : 0.05
  const gate = newest(pending)
  const contextUrl = gate && isLink(gate.ref_url) ? gate.ref_url : ''
  // A run can leave several gates (a content run leaves one per draft). Say so, or the human signs
  // one and wonders why the ? is still there — seen live 2026-09-06. Open goes to the next pending one.
  const gateLabel = gate ? (open.length > 1 ? `${gate.gate} (${pending.length} of ${open.length} left)` : gate.gate) : ''
  const art = newest(run.artifacts)
  const openUrl = openUrlFor(run, row, pending, opts)
  // Placed by client, never by actor (Annex III): its town on its company's planet, else the campus (U12).
  const at = typeof opts.place === 'function' ? opts.place(run.client) : { zone: run.client || CAMPUS, planet: '', pack: '' }

  // Bot Crossing never renders `preview`; the overlay panel (U11) does. For a pending gate it carries
  // the full instruction; otherwise the run's own notes, so the panel has something to say.
  const preview = gate
    ? `${gateLabel} — ${whatToDoLong(gate, run)}${open.length > 1 ? ` This run left ${open.length} of these; ${open.length - pending.length} already done, ${pending.length} still waiting — Open takes you to the next one.` : ''}`
    : run.terminal === 'run_failed'
      ? failedText(run, row)
      : (typeof row?.notes === 'string' && row.notes.trim()) || art?.title || `${run.trigger || 'unknown'} run`

  return {
    id: run.id,
    title: run.skill ? (gate ? `${run.skill} · ${gateLabel}` : run.skill) : 'Untitled run',
    preview,
    project: at.zone,
    planet: at.planet || '',
    pack: at.pack || '',
    projectPath: '',
    worktree: '',
    cwd: '',
    // the card's tag: what to do for a pending gate, the reason for a failed run, '' otherwise
    gitBranch: gate ? whatToDo(gate, run) : run.terminal === 'run_failed' ? `failed: ${run.failReason || 'no reason'}`.slice(0, 40) : '',
    model: (typeof row?.model === 'string' && row.model) || '',
    effort: '',
    createdAt: run.startedAt || run.lastAt,
    lastActivityAt: run.lastAt,
    lastFocusedAt: 0,
    // A run blocked on a human is waiting, not working: an open gate suspends ⚒ so the
    // renderer's precedence (⚒ before ?) never hides the one badge that wants you. Seen live
    // 2026-09-06: a live run with an open Pending Approval gate rendered as hammering.
    running: run.terminal == null && now - run.lastAt < runningTtlMs && pending.length === 0,
    unread,
    hasError: run.terminal === 'run_failed',
    starred: false,
    routine: false,
    archived: false,
    sizeBytes: sizeBytesForProgress(progress),
    hasTranscript: false,
    source: run.trigger || '',
    canOpen: openUrl != null,
    canArchive: false,
    // What the run made (U13): the overlay lists these on the card and bubbles the newest one.
    artifacts: artifactsOf(run, row),
    // The skill's trust status under AUTO_RUN_POLICY (U17): the suit colour, one per run_mode. Never a person's.
    trust: typeof opts.trustOf === 'function' ? opts.trustOf(run.skill, run.runClass) : { mode: 'unknown', source: 'none' },
    // The gates still open on their surface (U14): the in-tray orders by the oldest one; each says who can tap it.
    // An approval-layer gate also carries its own link (`url`: its ref_url, else its proposal in the Compass console,
    // else ''), so the tray's Approve opens that proposal and nothing else; every other gate's link is its ref_url.
    gates: pending.map((g) => ({ gate: g.gate, surface: g.surface, ref_url: isLink(g.ref_url) ? g.ref_url : '', at: g.at, canTap: viewer.canTap(g), what: whatToDo(g, run), ...(g.surface === 'approval' ? { url: gateUrl(g, opts) } : {}) })),
    gateAt: pending.length ? Math.min(...pending.map((g) => g.at)) : 0,
    ref: { run_id: run.id, url: openUrl, context: contextUrl && contextUrl !== openUrl ? contextUrl : '' },
  }
}

/**
 * A resident (U17): a skill Active in ops_skills with no run in 30 days has no figure of its own —
 * every figure is a run inside the window — so the campus keeps one for it, asleep, hand raised.
 * Not a run: nothing to open, no gates, no artifacts; the id says what it is.
 */
export function residentThread(skill, { now = Date.now(), place, trust, staleDays = 30 } = {}) {
  const at = typeof place === 'function' ? place('') : { zone: CAMPUS, planet: '', pack: '' }
  const since = now - staleDays * 24 * 3600 * 1000
  return {
    id: `skill:${skill.name}`,
    title: skill.name,
    preview: `No run in ${staleDays} days, and the skill is Active in ops_skills — the hand is up. Nothing to open: run it from where it lives, or retire it in Compass.`,
    project: at.zone,
    planet: at.planet || '',
    pack: at.pack || '',
    projectPath: '', worktree: '', cwd: '',
    gitBranch: 'hand raised · silent 30 d+',
    model: '', effort: '',
    // newest on its plot, so Bot Crossing (oldest first) seats every run before a resident
    createdAt: now,
    lastActivityAt: since,
    lastFocusedAt: 0,
    running: false, unread: false, hasError: false, starred: false, routine: false, archived: false,
    sizeBytes: sizeBytesForProgress(0.05),
    hasTranscript: false,
    source: 'ops_skills',
    canOpen: false, canArchive: false,
    ref: { run_id: '', url: null, context: '' },
    artifacts: [],
    trust: trust || { mode: 'unknown', source: 'none' },
    gates: [], gateAt: 0,
    resident: true,
    hand: true,
    skillType: skill.type || '',
  }
}

export { STALE_MS }
