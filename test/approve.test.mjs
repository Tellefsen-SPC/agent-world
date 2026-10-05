// Agent World — U15: Approve as a verb — deep-link, no write.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)

test('U15: Approve shows the instruction and the surface name first; the row is ⏳ until the ? clears, and a ? again ("not seen yet") after 3 polls', async () => {
  const { ApproveTracker, approveIntent, surfaceName, PATIENCE_POLLS } = await import(path.join(root, 'overlay/approve.mjs'))
  const alpha = { id: 'a', gate: 'ZZTEST gate', surface: 'pending_approval', what: 'approve in Airtable', url: 'https://airtable.com/appX/tblY/recZ' }
  const it = approveIntent(alpha)
  assert.equal(it.surface, 'Airtable · Pending Approval')
  assert.equal(it.what, 'approve in Airtable')
  assert.equal(it.url, alpha.url)
  assert.equal(approveIntent({ id: 'x', gate: 'g', surface: 'class_b_gate', url: '' }), null, 'a gate with no surface link has no Approve')
  assert.equal(surfaceName('decision'), 'Notion · 🧠 Decisions')

  const G = alpha.gate
  const U = alpha.url
  const tr = new ApproveTracker()
  assert.equal(tr.state('a', G, U), '')
  tr.mark('a', G, U, 1000)
  assert.equal(tr.state('a', G, U), '⏳')
  assert.equal(tr.glyph('a', G, U), '⏳')
  // The same roster seen twice is one poll, and polls inside the server's 5 s scan cache are one look
  // (the page also polls on focus, which is exactly when you come back from the surface).
  tr.update([alpha], 'poll-1', 10_000)
  tr.update([alpha], 'poll-1', 10_000)
  tr.update([alpha], 'poll-1b', 12_000)
  assert.equal(tr.state('a', G, U), '⏳')
  tr.update([alpha], 'poll-2', 25_000)
  assert.equal(tr.state('a', G, U), '⏳')
  tr.update([alpha], 'poll-3', 40_000)
  assert.equal(PATIENCE_POLLS, 3)
  assert.equal(tr.state('a', G, U), 'not seen yet')
  assert.equal(tr.glyph('a', G, U), '?')
  // The ? clears on a later poll (U6 saw the tap): the row is gone and so is the state.
  tr.update([], 'poll-4', 55_000)
  assert.equal(tr.state('a', G, U), '')
  // The happy path: cleared before patience runs out.
  const ok = new ApproveTracker()
  ok.mark('a', G, U, 1)
  ok.update([alpha], 'p1', 10_000)
  ok.update([], 'p2', 25_000)
  assert.equal(ok.state('a', G, U), '')
  // A run that left two gates: tapping the first clears ITS state when the row moves on to the second gate.
  // (two content drafts share the gate name "signature" and differ by page — the link is part of the key)
  const two = new ApproveTracker()
  two.mark('a', 'signature', 'https://n/blog', 1)
  two.update([{ ...alpha, gate: 'signature', url: 'https://n/blog' }], 'p1', 10_000)
  two.update([{ ...alpha, gate: 'signature', url: 'https://n/mirror' }], 'p2', 25_000)
  assert.equal(two.state('a', 'signature', 'https://n/blog'), '', 'the first draft was seen signed')
  assert.equal(two.state('a', 'signature', 'https://n/mirror'), '', 'the second was never approved from here')
})

test('U15: a row opens its OWN gate\'s surface, not the newest one — a run that left two drafts', async () => {
  const { intrayRows } = await import(path.join(root, 'overlay/intray.mjs'))
  const rows = intrayRows([
    {
      id: 'two', title: 'zztest-twodrafts · signature (2 of 2 left)', unread: true, running: false, hasError: false, gateAt: 1,
      ref: { url: 'https://app.notion.com/p/mirror' },
      gates: [
        { gate: 'signature', surface: 'content_status', ref_url: 'https://app.notion.com/p/mirror', at: 2, canTap: true, what: 'sign in Notion' },
        { gate: 'signature', surface: 'content_status', ref_url: 'https://app.notion.com/p/blog', at: 1, canTap: true, what: 'sign in Notion' },
      ],
    },
    { id: 'sess', title: 'build · permission:Bash', unread: true, running: false, hasError: false, gateAt: 1, ref: { url: 'https://claude.ai/project/x', context: 'https://app.notion.com/p/pack' },
      gates: [{ gate: 'permission:Bash', surface: 'class_b_gate', ref_url: 'https://app.notion.com/p/pack', at: 1, canTap: true, what: 'answer in the Claude Project' }] },
  ])
  assert.equal(rows.find((r) => r.id === 'two').url, 'https://app.notion.com/p/blog', 'the oldest draft, which the row describes')
  assert.equal(rows.find((r) => r.id === 'sess').url, 'https://claude.ai/project/x', 'a session gate opens where the answer goes, not its context page')
})

// U16 (2026-10-05): the overlay's one non-GET is the PA's question — POST to the sidecar's own /ask (zones.mjs askPa), never to
// the Worker; the sidecar adds the bearer (docs/adr/0008). It is the exact line below, once, and nothing else may compose a method.
const ASK_POST = "const res = await fetch(`${SIDECAR}/ask`, { method: 'POST',"
test('U15: Approve calls no Worker write route — the overlay makes no non-GET request except the layout seam (and the PA\'s question to the sidecar, U16), and never names the Worker', () => {
  const files = fs.readdirSync(path.join(root, 'overlay')).filter((f) => /\.(m?js)$/.test(f))
  const hits = []
  for (const f of files) {
    // code only: comments may say where the write path lives (M3's /actions); code may not go there
    let text = fs.readFileSync(path.join(root, 'overlay', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (f === 'zones.mjs') {
      if (text.split(ASK_POST).length !== 2) hits.push('zones.mjs: the PA\'s POST to the sidecar\'s /ask is not there exactly once')
      text = text.replace(ASK_POST, '')
    }
    if (/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(text)) hits.push(`${f} sets a write method`)
    if (/workers\.dev|\/events\b|\/ledger\/|\/actions\b|EVENTS_URL|BEARER/i.test(text)) hits.push(`${f} names the Worker or a bearer`)
    if (/\bfetch\(/.test(text) && f !== 'zones.mjs') hits.push(`${f} fetches (only zones.mjs may: the sidecar world and the layout seam)`)
  }
  assert.deepEqual(hits, [])
  // zones.mjs only forwards Bot Crossing's own /api/state verb to the sidecar; it composes no write of its own.
  const zones = fs.readFileSync(path.join(root, 'overlay/zones.mjs'), 'utf8').replace(ASK_POST, '')
  assert.ok(!/method:\s*['"]/.test(zones))
})
