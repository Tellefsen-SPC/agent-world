// Agent World — the approval layer's surface (Compass src/lib/approval, vendor/approval-layer): a waiting proposal is a
// gate_waiting with surface "approval" and gate "approval:<proposal id>"; the world shows it with something to click.
// Synthetic data only: zztest- skills, ZZTEST names, made-up uuids, a made-up Worker host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const { ALL_SURFACES, PRESETS, makeViewer } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))

/** A made-up proposal id in the shape the approval layer mints (crypto.randomUUID; the proposals table's id is uuid). */
const PROPOSAL = '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5'
const gateOf = (name = `approval:${PROPOSAL}`, extra = {}) => ({ gate: name, surface: 'approval', ref_url: '', at: 1, ...extra })

test('approval: the surface is in ALL_SURFACES and Owner-only — operator, client, prime and viewer never tap it (decided 2026-10-06, to ratify)', () => {
  assert.ok(ALL_SURFACES.includes('approval'), 'ALL_SURFACES names the approval surface')
  assert.deepEqual(PRESETS.owner.surfaces, ALL_SURFACES, 'the Owner sees every surface, as before')
  // D2: a ? only for someone who can resolve it. The layer's approver role defaults to Owner and gate_waiting does not
  // say which role a proposal needs, so an operator would hold ?s the console refuses them — until the event says so
  assert.deepEqual(PRESETS.operator.surfaces, ['pending_approval', 'class_b_gate'], 'the operator taps exactly what it did before')
  for (const preset of ['operator', 'client', 'prime', 'viewer']) assert.ok(!PRESETS[preset].surfaces.includes('approval'), `${preset} never taps an approval`)
  // gated the way every other surface is: canTap = the tap capability and the surface on the preset's list
  assert.equal(makeViewer({ preset: 'owner' }).canTap(gateOf()), true, 'the Owner taps an approval')
  for (const preset of ['operator', 'client', 'prime', 'viewer']) assert.equal(makeViewer({ preset }).canTap(gateOf()), false, `${preset} does not`)
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
    // the layer's gate name is approvalGateName's `approval:` exactly (review nit 6): another case of the word is not it
    `APPROVAL:${PROPOSAL}`, `Approval:${PROPOSAL}`, `aPPROVAL:${PROPOSAL}`,
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
  // belt and braces (review nit 7): a prefix of the right shape whose host or port the URL parser refuses — one
  // config.mjs never makes, since it builds the prefix from a parsed URL — gives nothing either
  for (const prefix of ['https://zztest<worker.example/console/proposals', 'https://zztest-worker.example:99999/console/proposals', 'https://zz%zz/console/proposals', 'https://[zz/console/proposals'])
    assert.equal(threadsMod.approvalConsoleUrl(`approval:${PROPOSAL}`, prefix), null, `no link under ${JSON.stringify(prefix)}`)
  // the hex itself may come in either case: the same uuid, linked in the lowercase the layer mints
  assert.equal(threadsMod.approvalConsoleUrl(`approval:${PROPOSAL.toUpperCase()}`, `${WORKER}/console/proposals`), CONSOLE)
})

test('approval: an approval gate opens only the console under EVENTS_URL — a ref_url only when it is that console link; a forged one never opens, labels or rides along (review 1)', async () => {
  // the approval layer never writes a ref_url on these events: anything here was written by someone else
  const forged = [
    `https://evil.example/console/proposals/${PROPOSAL}`,
    `https://zztest-worker.example@evil.example/console/proposals/${PROPOSAL}`,
    `https://zztest-worker.example.evil.example/console/proposals/${PROPOSAL}`,
    `http://zztest-worker.example/console/proposals/${PROPOSAL}`,
    `${WORKER}/console/proposals/${PROPOSAL}?next=https://evil.example`,
    `${WORKER}/console/proposals/${PROPOSAL}#https://evil.example`,
    `${WORKER}/console/proposals/../../evil.example`,
    `${WORKER}/console/proposals/${PROPOSAL}/../../../evil.example`,
    `${WORKER}/console/proposalsevil.example/${PROPOSAL}`,
    'https://zztest-surface.example/evil.example-proposal',
    'ops_config:ZZTEST_KEY_evil.example',
  ]
  for (const ref_url of forged) {
    const t = await threadFor({ gate: `approval:${PROPOSAL}`, ref_url })
    assert.equal(t.ref.url, CONSOLE, `the gate's own proposal, not ${ref_url}`)
    assert.equal(t.gates[0].url, CONSOLE)
    assert.equal(t.gates[0].ref_url, '', "an approval gate's ref_url is never passed on")
    assert.equal(t.ref.context, '', 'and never becomes the Context link')
    assert.equal(t.ref.console, true, 'the server says this Open is the console')
    assert.ok(!JSON.stringify(t).includes('evil'), `nothing of ${ref_url} reaches the thread`)
    // under a malformed name the forged ref_url still opens nothing
    const bad = await threadFor({ gate: 'approval:../x', ref_url })
    assert.equal(bad.ref.url, null, `no Open from ${ref_url}`)
    assert.equal(bad.gates[0].url, '')
    assert.equal(bad.ref.console, undefined, 'no console flag without a console link')
    assert.ok(!JSON.stringify(bad).includes('evil'))
  }
  // a ref_url that is itself a console link under this Worker, for a uuid, is taken (normalised), and wins over the
  // name's as a usable ref_url does for every gate
  const OTHER = '2f3e4d5c-6b7a-4899-8a7b-6c5d4e3f2a1b'
  const own = await threadFor({ gate: 'approval:../x', ref_url: `${WORKER}/console/proposals/${OTHER.toUpperCase()}` })
  assert.equal(own.ref.url, `${WORKER}/console/proposals/${OTHER}`)
  assert.equal(own.gates[0].url, `${WORKER}/console/proposals/${OTHER}`)
  assert.equal(own.ref.console, true)
  const both = await threadFor({ gate: `approval:${PROPOSAL}`, ref_url: `${WORKER}/console/proposals/${OTHER}` })
  assert.equal(both.ref.url, `${WORKER}/console/proposals/${OTHER}`)
  // an artifact the run left does not jump ahead of the gate's own surface
  const withArtifact = await threadFor({ gate: `approval:${PROPOSAL}` }, { extra: [ev('e3', 'artifact_registered', { title: 'ZZTEST page', notion_url: 'https://app.notion.com/p/zztest-page' })] })
  assert.equal(withArtifact.ref.url, CONSOLE)
  // and every other surface keeps its rule: a ref_url that is a link is the Open, labelled by where it lands
  const runs = fold([ev('e1', 'run_started'), ev('e2', 'gate_waiting', { surface: 'pending_approval', gate: 'ZZTEST gate', ref_url: 'https://airtable.com/appZZ/tblZZ/recZZ' })])
  const pa = await toThread(runs.get(RUN), null, makeViewer({ preset: 'owner' }), surfaces, NOW, { consoleProposalsUrl: `${WORKER}/console/proposals` })
  assert.equal(pa.ref.url, 'https://airtable.com/appZZ/tblZZ/recZZ')
  assert.equal(pa.ref.console, undefined)
})

const { intrayRows } = await import(path.join(root, 'overlay/intray.mjs'))
const approveMod = await import(path.join(root, 'overlay/approve.mjs'))

test("approval: the in-tray and the panel — the label, the surface's name, Approve to the gate's own proposal, \"Open in Compass\"", async () => {
  const t = await threadFor({ gate: `approval:${PROPOSAL}` })
  const [row] = intrayRows([t])
  assert.equal(row.what, 'approve in Compass', 'the tray row says what to do')
  assert.equal(row.surface, 'approval')
  assert.equal(row.url, CONSOLE, 'the row has an Approve, to the console')
  const it = approveMod.approveIntent(row)
  assert.equal(it.surface, 'Compass · approvals console', 'Approve names the surface before it opens')
  assert.equal(it.url, CONSOLE)
  assert.equal(typeof approveMod.openLabel, 'function', 'the Open label is pure, beside the surface names')
  assert.equal(approveMod.openLabel(t.ref.url, t.ref.console), 'Open in Compass', "the panel's Open button names Compass")
  // the label follows the server's flag, never the link's shape (review 1)
  assert.equal(approveMod.openLabel(CONSOLE), 'Open', 'a console-shaped link without the flag is just Open')
  assert.equal(approveMod.openLabel(`https://evil.example/console/proposals/${PROPOSAL}`), 'Open')
  assert.equal(approveMod.openLabel('', true), 'Nothing to open')
  assert.equal(approveMod.openLabel(CONSOLE, 'yes'), 'Open', 'only a true flag')
  // the labels the other surfaces had stay as they were
  assert.equal(approveMod.openLabel('https://airtable.com/appX/tblY/recZ'), 'Open in Airtable')
  assert.equal(approveMod.openLabel('https://app.notion.com/p/zztest'), 'Open in Notion')
  assert.equal(approveMod.openLabel('https://claude.ai/project/zztest'), 'Open the Claude Project')
  assert.equal(approveMod.openLabel('https://zztest.example/elsewhere'), 'Open')
  assert.equal(approveMod.openLabel(''), 'Nothing to open')
  assert.equal(approveMod.openLabel(null), 'Nothing to open')

  // two proposals on one run: the row is the oldest gate, and its Approve opens that proposal — not the newest
  const SECOND = '1e2d3c4b-5a69-4788-9766-554433221100'
  const two = await threadFor({ gate: `approval:${PROPOSAL}` }, { extra: [ev('e3', 'gate_waiting', { surface: 'approval', gate: `approval:${SECOND}` }, { at: '2026-10-06T07:30:00Z' })] })
  assert.equal(two.ref.url, `${WORKER}/console/proposals/${SECOND}`, 'Open goes to the newest gate, as for every run')
  const [r2] = intrayRows([two])
  assert.equal(r2.gate, `approval:${PROPOSAL}`)
  assert.equal(r2.url, CONSOLE, "the row's Approve opens its own proposal")

  // a malformed name: no Approve, even when the run carries some other link
  const bad = await threadFor({ gate: 'approval:../x' }, { extra: [ev('e3', 'artifact_registered', { title: 'ZZTEST page', notion_url: 'https://app.notion.com/p/zztest-page' })] })
  const [r3] = intrayRows([bad])
  assert.equal(r3.what, 'approve in Compass')
  assert.equal(r3.url, '', 'Approve on an approval gate goes to its proposal or nowhere')
  assert.equal(approveMod.approveIntent(r3), null)
})

test('approval: never cross-checked — the layer closes its own gates with gate_passed, and the ledger says so (a pin)', async () => {
  const { createSurfaces, crossCheckable } = await import(path.join(root, 'server/harnesses/compass/surfaces.mjs'))
  assert.equal(crossCheckable({ surface: 'approval', ref_url: CONSOLE }), false)
  const s = createSurfaces({ airtableToken: 'zztest', notionToken: 'zztest', airtableBaseId: 'appZZTEST' }, { fetchImpl: async () => assert.fail('an approval gate is never read on a surface') })
  assert.equal(await s.gateResolved({ run_id: RUN, gate: `approval:${PROPOSAL}`, surface: 'approval', ref_url: CONSOLE }), false)
  // its own gate_passed, read from the ledger, is what closes it
  const closed = await threadFor({ gate: `approval:${PROPOSAL}` }, { extra: [ev('e3', 'gate_passed', { surface: 'approval', gate: `approval:${PROPOSAL}`, result: 'approved' }, { at: '2026-10-06T07:10:00Z' })] })
  assert.deepEqual(closed.gates, [])
  assert.equal(closed.unread, false)
})

test("approval: the panel's Open label is approve.mjs's, fed the server's flag — main.js defines none of its own (review 4)", () => {
  // like test/pa.test.mjs's static checks: main.js needs a DOM, so its wiring is read, not run
  const main = fs.readFileSync(path.join(root, 'overlay/main.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(main, /import\s*\{[^}]*\bopenLabel\b[^}]*\}\s*from\s*'\.\/approve\.mjs'/, 'main.js imports openLabel from ./approve.mjs')
  assert.ok(!/(?:\b(?:const|let|var|function)\s+openLabel\b|\bopenLabel\s*=)/.test(main), 'main.js defines no openLabel of its own')
  assert.match(main, /openLabel\(url, thread\.ref\?\.console\)/, "the run panel's Open button passes the server's console flag")
})
