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
