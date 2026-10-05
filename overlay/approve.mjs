// overlay/approve.mjs — Approve as a verb (U15): deep-link, no write. Pure; node runs it under npm test.
//
// Decision 2026-09-06 (Active, Settled): at M2 Approve opens the gate's surface with the instruction
// shown first; the tap happens THERE. The world writes nothing — the write path is M3's /actions on
// the Worker, never here. What this module owns is the row's state after the click:
//   ⏳  from the click until U6's cross-check clears the ? on a later poll
//   ?   again, with "not seen yet", if the gate is still open after 3 polls (ES-4.5)
// Nothing is stored: the tracker lives for the page, like the tray's cursor.

export const PATIENCE_POLLS = 3
/** Polls closer together than this see the same server scan (compass.mjs scanCacheMs) — they are one look, not two. */
export const POLL_GAP_MS = 5_000
/** run + gate name + the gate's link: two drafts of one content run share a gate name and differ by page. */
export const keyOf = (id, gate, url) => `${id}|${gate || ''}|${url || ''}`

/** The surface a gate lives on, named for a human. */
export const SURFACE_NAME = {
  pending_approval: 'Airtable · Pending Approval',
  decision: 'Notion · 🧠 Decisions',
  content_status: 'Notion · ✍️ Content',
  class_b_gate: 'the session that asked',
  client_gate: "the client's surface",
  approval: 'Compass · approvals console',
}
export const surfaceName = (surface) => SURFACE_NAME[surface] || surface || 'its surface'

/**
 * The Open button's label, named by where it lands (the selection panel, overlay/main.js). "Open in Compass" only when
 * the server says Open is the Compass console's page for a proposal (`thread.ref.console`, compass/threads.mjs) — never
 * from the link's shape, which anyone who can write an event could copy onto another host (review 1, 2026-10-06).
 */
export const openLabel = (url, console = false) => (!url ? 'Nothing to open' : console === true ? 'Open in Compass' : /airtable\.com/.test(url) ? 'Open in Airtable' : /notion\.(com|so)/.test(url) ? 'Open in Notion' : /claude\.ai/.test(url) ? 'Open the Claude Project' : 'Open')

/** What Approve will show before the surface opens: the instruction and where it is going. */
export function approveIntent(row) {
  if (!row?.url) return null
  return { id: row.id, surface: surfaceName(row.surface), what: row.what || `Resolve "${row.gate}" on its surface.`, url: row.url, gate: row.gate }
}

export class ApproveTracker {
  constructor({ patience = PATIENCE_POLLS } = {}) {
    this.patience = patience
    this.pending = new Map() // thread id → { since, polls, lastRoster }
  }

  /** The click: remember it; the row wears ⏳ from now. */
  mark(id, gate, url, now = Date.now()) {
    if (!id) return
    this.pending.set(keyOf(id, gate, url), { since: now, polls: 0, rosterKey: '', countedAt: 0 })
  }

  /**
   * Every roster (one per poll): a thread whose ? is gone is cleared (the surface saw the tap);
   * one still waiting after `patience` polls goes back to ? with "not seen yet".
   * @param rows the in-tray rows right now (every open ?)
   * @param rosterKey something that changes once per poll (the poll's own timestamp)
   */
  update(rows, rosterKey, now = Date.now()) {
    // keyed by run + gate: a run that left several gates keeps its row (on its next gate) after one is tapped
    const open = new Set((rows || []).map((r) => keyOf(r.id, r.gate, r.url)))
    for (const [key, p] of this.pending) {
      if (!open.has(key)) {
        this.pending.delete(key) // the ? cleared — the tap landed and U6 saw it
        continue
      }
      if (p.rosterKey !== rosterKey && now - p.countedAt >= POLL_GAP_MS) {
        p.rosterKey = rosterKey
        p.countedAt = now
        p.polls += 1
      }
    }
  }

  /** '⏳' while waiting for the surface to be seen; 'not seen yet' after patience ran out; '' otherwise. */
  state(id, gate, url) {
    const p = this.pending.get(keyOf(id, gate, url))
    if (!p) return ''
    return p.polls >= this.patience ? 'not seen yet' : '⏳'
  }
  glyph(id, gate, url) {
    return this.state(id, gate, url) === '⏳' ? '⏳' : '?'
  }
}
