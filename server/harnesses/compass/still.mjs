/**
 * The still map (U28, ES-6.1–6.3, 6.10). Pure: the folded runs, their M1-shaped threads, the
 * substrate rows and the pack in; the world's threads out. No I/O, no clock of its own.
 *
 * A thread is one of two things and nothing else:
 *   fixture  one per Active Notion Project (zone = its client's town, an internal project = the
 *            workshop) and one per room board the pack declares (zone = that room's plot). Always
 *            idle: never ?, never !, never working. A project fixture carries `running` (n live runs
 *            on it, each with its sub-run count) and `check` (a milestone flipped Done in 24 h) as
 *            static marks — the overlay draws them; nothing animates.
 *   request  one per open ? — a pending gate on a run, a Pending Approval row at Pending Approval,
 *            a Decision at Pending, a Content row In Review — and per ! — a run_failed inside 24 h
 *            with no later completion of the same skill, an open System Health finding. It carries
 *            the badge and stands where the request belongs (ES-6.3). Title = badge · verb · surface.
 * Running, completed and sleeping runs produce no thread: a live run is a count on its project
 * fixture, a completed one is on the archive shelf, a sleeping one is nowhere.
 *
 * Placement (Annex III: by client, project and room, never by actor): a request with a client that
 * is a town stands in that town; a client that is not a town counts as none — a run's request then
 * stands in its skill's room, a surface row (no run, no skill) in its surface's room (Pending Approval →
 * corner office, Decision → board room, Content → marketing studio, System Health → records office), a
 * ! with no town in the records office — never on an ad-hoc plot, so the generated layout (U29) is the
 * whole map. A sub-run stands where its root ancestor stands. A live run that names no Active project
 * is counted in the strip's "running" and on its town's plate (U30) but has no fixture to stand on.
 * A run that failed while its Pending Approval gate was open is a ! and the row is still a ? of its own.
 */
import { roomForSkill, roomName, roomsOf } from './pack.mjs'
import { notionId, airtableRef } from './surfaces.mjs'
import { sizeBytesForProgress, whatToDo, whatToDoLong, askedGate, waitsOnOthers } from './threads.mjs'

export const DAY_MS = 24 * 3600 * 1000
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const undash = (id) => str(id).replace(/-/g, '').toLowerCase()

/** badge · verb · surface — the request's title (ES-6.3). */
export function verbFor(surface, gateName = '') {
  switch (surface) {
    case 'pending_approval': return 'Approve · Airtable'
    case 'decision': return 'Confirm · Decision'
    case 'content_status': return 'Sign · Content'
    case 'class_b_gate': return 'Answer · session'
    case 'client_gate': return "Client's tap · client"
    case 'approval': return 'Approve · Compass'
    case 'system_health': return 'Resolve · System Health'
    default: return `Resolve · ${gateName || surface || 'gate'}`
  }
}

/** A run_failed inside the window with no later run_completed for the same skill (U17's rule, per run). */
export function failedRecently(run, runs, now, windowMs = DAY_MS) {
  if (run.terminal !== 'run_failed' || now - run.lastAt > windowMs) return false
  for (const r of runs.values()) if (r.skill === run.skill && r.terminal === 'run_completed' && r.lastAt > run.lastAt) return false
  return true
}
/**
 * Live: started, and the adapter's own `running` — no terminal event, activity within the TTL, no pending gate (ES-6.2).
 * `running` is worked out from every pending gate, whoever is looking; `gates` holds only the ones this viewer may see,
 * so it cannot say whether a run waits on a person (confirmation 1, 2026-10-06). `now` and `ttlMs` are kept for callers.
 */
export const isLive = (run, thread, now, ttlMs) => Boolean(run.started) && Boolean(thread?.running)

/** What kind of thread this is — the test fails on a null. */
export function kindOf(t) {
  if (!t || typeof t !== 'object') return null
  if (t.kind === 'fixture') return !t.unread && !t.running && !t.hasError && (t.fixture === 'project' || t.fixture === 'board') ? 'fixture' : null
  if (t.kind === 'request') return (t.badge === '?' && (t.unread || (t.gates || []).length)) || (t.badge === '!' && t.hasError) ? 'request' : null
  return null
}

const base = (over) => ({
  projectPath: '', worktree: '', cwd: '', model: '', effort: '', lastFocusedAt: 0,
  starred: false, routine: false, archived: false, hasTranscript: false, canArchive: false,
  artifacts: [], gates: [], gateAt: 0, trust: { mode: 'unknown', source: 'none' },
  ...over,
})

export function buildStill({ now, ttlMs = 2 * 3600 * 1000, runs, threadOf, projects = [], paRows = [], decisions = [], contentRows = null, healthRows = null, pack, place, skillTypes = new Map(), viewer = null }) {
  const home = place('')
  const rooms = roomsOf(pack)
  const roomZone = (roomId) => ({ zone: roomName(pack, roomId), planet: home.planet, pack: home.pack, room: roomId, town: false })
  const townOrRoom = (clientName, roomId) => {
    const at = str(clientName) ? place(clientName) : null
    return at?.town ? { zone: at.zone, planet: at.planet, pack: at.pack, room: '', town: true } : roomZone(roomId)
  }
  const roomOfSkill = (skill) => roomForSkill(pack, skill, skillTypes.get(str(skill)) || '').room
  const children = new Map() // parent id → [runs]
  for (const r of runs.values()) if (r.parentId && runs.has(r.parentId)) (children.get(r.parentId) || children.set(r.parentId, []).get(r.parentId)).push(r)
  const subrunsOf = (run) => (children.get(run.id) || []).map((c) => ({ id: c.id, title: c.skill || 'sub-run', unread: Boolean(threadOf.get(c.id)?.unread), running: isLive(c, threadOf.get(c.id), now, ttlMs), hasError: c.terminal === 'run_failed', waiting: waitsOnOthers(threadOf.get(c.id)), gitBranch: threadOf.get(c.id)?.gitBranch || '' }))

  const threads = []
  const runningByProject = new Map() // undashed project id → [{ id, skill, subruns, at }]
  const gatedRecords = new Set() // Airtable record ids / Notion page ids a pending gate already points at
  const counts = { needYou: 0, blocked: 0, running: 0, shippedToday: 0 }
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)

  // ── requests from runs ─────────────────────────────────────────────────────────────────
  for (const run of runs.values()) {
    const t = threadOf.get(run.id)
    if (!t) continue
    if (run.terminal === 'run_completed' && run.lastAt >= dayStart.getTime()) counts.shippedToday++
    const pending = Array.isArray(t.gates) ? t.gates : []
    const parent = run.parentId && runs.has(run.parentId) ? runs.get(run.parentId) : null
    // a sub-run stands where its root ancestor stands (U18, ES-4.9): placed by the root's client, never by actor
    let root = run
    for (let hops = 0; hops < 8 && root.parentId && runs.has(root.parentId) && root.parentId !== root.id; hops++) root = runs.get(root.parentId)
    if (failedRecently(run, runs, now)) {
      const at = townOrRoom(root.client, 'records-office')
      counts.blocked++
      threads.push(base({
        ...t,
        kind: 'request', request: 'failed', badge: '!', skill: run.skill, room: at.room,
        title: `! Failed · ${run.skill || 'run'}`,
        project: at.zone, planet: at.planet, pack: at.pack,
        running: false, unread: false, hasError: true,
        parentId: parent ? parent.id : '', parentTitle: parent ? parent.skill : '',
        subruns: subrunsOf(run),
      }))
      continue
    }
    if (pending.length) {
      for (const g of pending) {
        const rec = airtableRef(g.ref_url)?.record
        if (rec) gatedRecords.add(rec)
        const pid = notionId(g.ref_url)
        if (pid) gatedRecords.add(undash(pid))
      }
      // A ? only for a gate this viewer can tap (D2, 2026-09-05): a gate that is someone else's makes no thread for
      // this viewer — the still map has no quiet figure to give it (M1 showed one). Owner taps every surface.
      if (!t.unread) continue
      // titled by the gate the thread is about — the oldest this viewer can tap, else the oldest (threads.mjs askedGate):
      // on a run with a client_gate and a proposal, the client's own (review 2); one gate for title and card (confirmation 4)
      const g = askedGate(pending)
      const at = townOrRoom(root.client, roomOfSkill(run.skill))
      counts.needYou++
      threads.push(base({
        ...t,
        kind: 'request', request: 'gate', badge: '?', skill: run.skill, room: at.room,
        title: `? ${verbFor(g.surface, g.gate)}`,
        project: at.zone, planet: at.planet, pack: at.pack,
        running: false, hasError: false,
        parentId: parent ? parent.id : '', parentTitle: parent ? parent.skill : '',
        subruns: subrunsOf(run),
      }))
      continue
    }
    if (isLive(run, t, now, ttlMs)) {
      counts.running++
      const key = undash(run.project)
      const entry = { id: run.id, skill: run.skill, at: run.lastAt, subruns: (children.get(run.id) || []).length, client: run.client || '' }
      if (key) (runningByProject.get(key) || runningByProject.set(key, []).get(key)).push(entry)
    }
    // completed, sleeping, idle: no thread
  }

  // ── requests from surfaces ────────────────────────────────────────────────────────────
  for (const row of paRows) {
    if (!row?.id || gatedRecords.has(row.id)) continue
    const at = townOrRoom(row.clientName, 'corner-office')
    const gate = { gate: row.title || 'Pending Approval row', surface: 'pending_approval', ref_url: row.url || '', at: row.at || now, canTap: viewer ? viewer.canTap({ surface: 'pending_approval' }) : true, what: whatToDo({ surface: 'pending_approval' }, null) }
    if (!gate.canTap) continue
    counts.needYou++
    threads.push(base({
      id: `pa:${row.id}`, kind: 'request', request: 'pa', badge: '?', skill: row.type || 'Pending Approval', room: at.room,
      title: `? ${verbFor('pending_approval')}`,
      preview: `${gate.gate} — ${whatToDoLong({ surface: 'pending_approval' }, null)}${row.summary ? ` ${row.summary}` : ''}`,
      gitBranch: gate.what,
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: gate.at, lastActivityAt: gate.at,
      running: false, unread: gate.canTap, hasError: false,
      sizeBytes: sizeBytesForProgress(0.05), source: 'airtable', canOpen: Boolean(gate.ref_url),
      gates: [gate], gateAt: gate.at, ref: { run_id: '', url: gate.ref_url || null, context: '' },
      clientName: row.clientName || '',
    }))
  }
  for (const d of decisions) {
    if (!d?.id || gatedRecords.has(undash(d.id))) continue
    const at = roomZone('board-room')
    const gate = { gate: d.title || 'Decision', surface: 'decision', ref_url: d.url || '', at: d.at || now, canTap: viewer ? viewer.canTap({ surface: 'decision' }) : true, what: whatToDo({ surface: 'decision' }, null) }
    if (!gate.canTap) continue
    counts.needYou++
    threads.push(base({
      id: `decision:${undash(d.id)}`, kind: 'request', request: 'decision', badge: '?', skill: 'Decision', room: at.room,
      title: `? ${verbFor('decision')}`,
      preview: `${gate.gate} — ${whatToDoLong({ surface: 'decision' }, null)}`,
      gitBranch: gate.what,
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: gate.at, lastActivityAt: gate.at,
      running: false, unread: gate.canTap, hasError: false,
      sizeBytes: sizeBytesForProgress(0.05), source: 'notion', canOpen: Boolean(gate.ref_url),
      gates: [gate], gateAt: gate.at, ref: { run_id: '', url: gate.ref_url || null, context: '' },
    }))
  }
  for (const c of contentRows || []) {
    if (!c?.id || gatedRecords.has(undash(c.id))) continue
    const at = roomZone('marketing-studio')
    const gate = { gate: c.title || 'Content draft', surface: 'content_status', ref_url: c.url || '', at: c.at || now, canTap: viewer ? viewer.canTap({ surface: 'content_status' }) : true, what: whatToDo({ surface: 'content_status' }, null) }
    if (!gate.canTap) continue
    counts.needYou++
    threads.push(base({
      id: `content:${undash(c.id)}`, kind: 'request', request: 'content', badge: '?', skill: 'Content', room: at.room,
      title: `? ${verbFor('content_status')}`,
      preview: `${gate.gate} — ${whatToDoLong({ surface: 'content_status' }, null)}`,
      gitBranch: gate.what,
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: gate.at, lastActivityAt: gate.at,
      running: false, unread: gate.canTap, hasError: false,
      sizeBytes: sizeBytesForProgress(0.05), source: 'notion', canOpen: Boolean(gate.ref_url),
      gates: [gate], gateAt: gate.at, ref: { run_id: '', url: gate.ref_url || null, context: '' },
    }))
  }
  for (const h of healthRows || []) {
    if (!h?.id) continue
    const at = roomZone('records-office')
    counts.blocked++
    threads.push(base({
      id: `health:${undash(h.id)}`, kind: 'request', request: 'health', badge: '!', skill: 'System Health', room: at.room,
      title: `! Open · System Health`,
      preview: `${h.title || 'An open System Health finding'} — an open 🩺 System Health finding${[h.severity, h.source, h.table && `Airtable ${h.table}`].filter(Boolean).length ? ` (${[h.severity, h.source, h.table && `Airtable ${h.table}`].filter(Boolean).join(' · ')})` : ''}. Nothing in a surface waits on a tap; resolve or close it in Notion.`,
      gitBranch: 'open finding',
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: h.at || now, lastActivityAt: h.at || now,
      running: false, unread: false, hasError: true,
      sizeBytes: sizeBytesForProgress(0.05), source: 'notion', canOpen: Boolean(h.url),
      ref: { run_id: '', url: h.url || null, context: '' },
    }))
  }

  // ── fixtures ──────────────────────────────────────────────────────────────────────────
  for (const room of rooms) {
    const at = roomZone(room.id)
    threads.push(base({
      id: `board:${room.id}`, kind: 'fixture', fixture: 'board', badge: '', skill: '', room: room.id,
      title: room.name, preview: room.mirrors || `the ${room.name} board`, gitBranch: '',
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: 1, lastActivityAt: now,
      running: false, unread: false, hasError: false,
      sizeBytes: sizeBytesForProgress(0.05), source: 'pack', canOpen: false,
      ref: { run_id: '', url: null, context: '' },
      surface: room.surface,
    }))
  }
  projects.forEach((p, i) => {
    const at = p.internal ? roomZone('workshop') : townOrRoom(p.clientName, 'workshop')
    const live = runningByProject.get(undash(p.id)) || []
    const ms = p.milestones || { value: 0.05, list: [], doneAt: 0 }
    threads.push(base({
      id: `project:${undash(p.id)}`, kind: 'fixture', fixture: 'project', badge: '', skill: '', room: at.room,
      title: p.name || 'Untitled project',
      preview: [p.engagementType ? `${p.engagementType} project` : 'project', p.clientName ? `for ${p.clientName}` : 'internal', p.techStack?.length ? `· ${p.techStack.join(', ')}` : ''].filter(Boolean).join(' '),
      gitBranch: live.length ? `⚒ ${live.length} running` : ms.doneAt && now - ms.doneAt <= DAY_MS ? '✓ milestone done' : '',
      project: at.zone, planet: at.planet, pack: at.pack,
      createdAt: 2 + i, lastActivityAt: now,
      running: false, unread: false, hasError: false,
      sizeBytes: sizeBytesForProgress(ms.value), source: 'notion', canOpen: Boolean(p.url),
      ref: { run_id: '', url: p.url || null, context: '' },
      projectId: p.id, clientName: p.clientName || '', internal: Boolean(p.internal), techStack: p.techStack || [], engagementType: p.engagementType || '',
      runningCount: live.length, runningRuns: live.slice().sort((a, b) => b.at - a.at), check: Boolean(ms.doneAt) && now - ms.doneAt <= DAY_MS,
      milestones: (ms.list || []).map((m) => ({ id: m.id, name: m.name, status: m.status, done: Boolean(m.done), committed: m.committed || 0, url: m.url || '' })),
    }))
  })

  return { threads, counts, runningByProject }
}
