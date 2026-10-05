// Agent World — the approval layer's surface (Compass src/lib/approval, vendor/approval-layer): a waiting proposal is a
// gate_waiting with surface "approval" and gate "approval:<proposal id>"; the world shows it with something to click.
// Synthetic data only: zztest- skills, ZZTEST names, made-up uuids, a made-up Worker host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { ALL_SURFACES, PRESETS, makeViewer } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))

/** A made-up proposal id in the shape the approval layer mints (crypto.randomUUID; the proposals table's id is uuid). */
const PROPOSAL = '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5'
const gateOf = (name = `approval:${PROPOSAL}`, extra = {}) => ({ gate: name, surface: 'approval', ref_url: '', at: 1, ...extra })

test('approval: the surface is in ALL_SURFACES and on the operator preset, beside pending_approval and class_b_gate — never on client or prime', () => {
  assert.ok(ALL_SURFACES.includes('approval'), 'ALL_SURFACES names the approval surface')
  assert.deepEqual(PRESETS.owner.surfaces, ALL_SURFACES, 'the Owner sees every surface, as before')
  assert.ok(PRESETS.operator.surfaces.includes('approval'), 'the operator taps approvals')
  for (const s of ['pending_approval', 'class_b_gate']) assert.ok(PRESETS.operator.surfaces.includes(s), `operator keeps ${s}`)
  for (const preset of ['client', 'prime', 'viewer']) assert.ok(!PRESETS[preset].surfaces.includes('approval'), `${preset} never sees an approval`)
  // gated the way every other surface is: canTap = the tap capability and the surface on the preset's list
  for (const preset of ['owner', 'operator']) assert.equal(makeViewer({ preset }).canTap(gateOf()), true, `${preset} taps an approval`)
  for (const preset of ['client', 'prime', 'viewer']) assert.equal(makeViewer({ preset }).canTap(gateOf()), false, `${preset} does not`)
})

const { whatToDo, whatToDoLong } = await import(path.join(root, 'server/harnesses/compass/threads.mjs'))
const { verbFor } = await import(path.join(root, 'server/harnesses/compass/still.mjs'))
const LONG = 'A proposal is waiting for an approver. Open it in the Compass console and approve, edit or reject it.'

test('approval: the labels — "approve in Compass" on the tag and the tray, the full line in the panel, "Approve · Compass" in the title', () => {
  assert.equal(whatToDo(gateOf(), { trigger: 'cowork_scheduled' }), 'approve in Compass')
  assert.equal(whatToDoLong(gateOf(), { trigger: 'cowork_scheduled' }), LONG)
  assert.ok('approve in Compass'.length <= 20, "fits Bot Crossing's own card tag")
  // the request's title is badge · verb · surface (ES-6.3) — never the raw gate name
  assert.equal(verbFor('approval', `approval:${PROPOSAL}`), 'Approve · Compass')
})

const { loadConfig } = await import(path.join(root, 'server/harnesses/compass/config.mjs'))
const { fold } = await import(path.join(root, 'server/harnesses/compass/fold.mjs'))
const { toThread } = await import(path.join(root, 'server/harnesses/compass/threads.mjs'))
const threadsMod = await import(path.join(root, 'server/harnesses/compass/threads.mjs'))
const WORKER = 'https://zztest-worker.example'
const CONSOLE = `${WORKER}/console/proposals/${PROPOSAL}`
const RUN = 'a1a1a1a1-0000-4000-8000-0000000000c1'
const NOW = Date.parse('2026-10-06T08:00:00Z')
const ev = (id, event_type, payload = {}, over = {}) => ({ id, run_id: RUN, at: '2026-10-06T07:00:00Z', event_type, skill: 'zztest-approver', trigger: 'cowork_scheduled', client: 'ZZTEST Client', project: null, actor: 'cowork', payload, ...over })
const surfaces = { progress: async () => 0.05, gateResolved: async () => false }
/** One run, one approval gate, through the real fold and toThread, with the console prefix config.mjs derives from EVENTS_URL. */
async function threadFor(gatePayload, { eventsUrl = `${WORKER}/events`, extra = [] } = {}) {
  const cfg = loadConfig({ EVENTS_URL: eventsUrl, EVENTS_BEARER_TOKEN: 'zztest-bearer' })
  const runs = fold([ev('e1', 'run_started'), ev('e2', 'gate_waiting', { surface: 'approval', ...gatePayload }), ...extra])
  return toThread(runs.get(RUN), null, makeViewer({ preset: 'owner' }), surfaces, NOW, { consoleProposalsUrl: cfg.consoleProposalsUrl })
}

test('approval: config.mjs derives the console from EVENTS_URL — https only, the Worker base, nothing else', () => {
  const at = (EVENTS_URL) => loadConfig({ EVENTS_URL }).consoleProposalsUrl
  assert.equal(at(`${WORKER}/events`), `${WORKER}/console/proposals`, 'EVENTS_URL with its /events tail removed')
  assert.equal(at(`${WORKER}/events/`), `${WORKER}/console/proposals`, 'a trailing slash is dropped first, as for every route')
  assert.equal(at(`${WORKER}/zztest-compass/events`), `${WORKER}/zztest-compass/console/proposals`, 'a Worker under a path keeps it')
  for (const bad of ['http://zztest-worker.example/events', 'https://zztest-worker.example/ledger', 'https://zztest:secret@zztest-worker.example/events', 'https://zztest-worker.example/events?x=1', 'https://zztest-worker.example/events#x', 'javascript:alert(1)//events', '', 'not a url'])
    assert.equal(at(bad), '', `no console for ${JSON.stringify(bad)}`)
})

test('approval: an approval:<uuid> gate opens the Compass console at <worker base>/console/proposals/<proposal id>', async () => {
  const t = await threadFor({ gate: `approval:${PROPOSAL}` })
  assert.equal(t.ref.url, CONSOLE, 'Open lands on the proposal in the console')
  assert.equal(t.canOpen, true)
  assert.equal(t.gates.length, 1)
  assert.equal(t.gates[0].url, CONSOLE, "the gate carries its own link, for the in-tray's Approve")
  assert.equal(t.gates[0].ref_url, '', 'the ledger sent no ref_url, and none is invented on it')
  assert.equal(t.gitBranch, 'approve in Compass')
  assert.equal(t.preview, `approval:${PROPOSAL} — ${LONG}`, 'the panel: the gate, then the full line')
  assert.equal(t.unread, true, 'the Owner holds the ?')
  // an uppercase uuid is the same uuid (RFC 9562: case-insensitive on input); the link carries the lowercase form the
  // approval layer mints (crypto.randomUUID), so a case-sensitive console route still finds it
  const upper = await threadFor({ gate: `approval:${PROPOSAL.toUpperCase()}` })
  assert.equal(upper.ref.url, CONSOLE)
  // under a Worker that is not https there is no console link at all
  const plain = await threadFor({ gate: `approval:${PROPOSAL}` }, { eventsUrl: 'http://zztest-worker.example/events' })
  assert.equal(plain.ref.url, null)
  assert.equal(plain.canOpen, false)
})

test('approval: a malformed or injected gate name gives no link — never a broken or injected one', async () => {
  const bad = [
    'approval:', 'approval:../x', 'approval:<script>', 'approval:a b', `approval:${PROPOSAL}?next=https://evil.example`, `approval:${PROPOSAL}#x`,
    `approval:?${PROPOSAL}`, `approval:#${PROPOSAL}`, `approval:${PROPOSAL}/../../ledger/zztest`, `approval:../${PROPOSAL}`, `approval:%2e%2e%2f${PROPOSAL}`,
    `approval:${PROPOSAL}\n`, ` approval:${PROPOSAL}`, `approval: ${PROPOSAL}`, `approval:${PROPOSAL.slice(0, -1)}`, `approval:${PROPOSAL}0`, `approval:${PROPOSAL.replace(/-/g, '')}`,
    `approval:${PROPOSAL.replace('a', 'g')}`, `approval:javascript:alert(1)`, `proposal:${PROPOSAL}`, PROPOSAL, 'approval', '',
  ]
  for (const name of bad) {
    assert.equal(threadsMod.approvalConsoleUrl(name, `${WORKER}/console/proposals`), null, `no link for ${JSON.stringify(name)}`)
    const t = await threadFor({ gate: name })
    assert.equal(t.ref.url, null, `no Open for ${JSON.stringify(name)}`)
    assert.equal(t.canOpen, false)
    assert.equal(t.gates[0].url, '', `no gate link for ${JSON.stringify(name)}`)
    assert.equal(t.unread, true, 'the ? stays: a human is still waited on, there is just nothing safe to open')
  }
  // only the https console prefix config.mjs derives — a prefix handed in any other shape gives nothing
  for (const prefix of ['http://zztest-worker.example/console/proposals', 'https://zztest-worker.example/ledger/scan', 'https://zztest-worker.example/console/proposals/', 'javascript:alert(1)//console/proposals', '', undefined])
    assert.equal(threadsMod.approvalConsoleUrl(`approval:${PROPOSAL}`, prefix), null, `no link under ${JSON.stringify(prefix)}`)
})

test('approval: a gate that carries a usable ref_url opens it, as every gate does; a ref_url that is not a link falls back to the console', async () => {
  const elsewhere = 'https://zztest-surface.example/zztest-proposal'
  const linked = await threadFor({ gate: `approval:${PROPOSAL}`, ref_url: elsewhere })
  assert.equal(linked.ref.url, elsewhere, 'the ref_url wins, the rule for every gate')
  assert.equal(linked.gates[0].url, elsewhere)
  assert.equal(linked.gates[0].ref_url, elsewhere)
  const reference = await threadFor({ gate: `approval:${PROPOSAL}`, ref_url: 'ops_config:ZZTEST_KEY' })
  assert.equal(reference.ref.url, CONSOLE, 'a Compass reference is never an Open target; the console is')
  assert.equal(reference.gates[0].url, CONSOLE)
  // an artifact the run left does not jump ahead of the gate's own surface
  const withArtifact = await threadFor({ gate: `approval:${PROPOSAL}` }, { extra: [ev('e3', 'artifact_registered', { title: 'ZZTEST page', notion_url: 'https://app.notion.com/p/zztest-page' })] })
  assert.equal(withArtifact.ref.url, CONSOLE)
})
