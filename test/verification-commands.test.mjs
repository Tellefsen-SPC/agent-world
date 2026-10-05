// Agent World — the commands VERIFICATION.md hands the verifier are run here on synthetic answers, so a check that prints
// what it should not (a proposal's payload, a ledger row, an actor) fails before anyone types it. V-U38 first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const doc = fs.readFileSync(path.join(root, 'VERIFICATION.md'), 'utf8')
const section = (id) => {
  const start = doc.indexOf(`## ${id} `)
  assert.ok(start >= 0, `${id} is in VERIFICATION.md`)
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end < 0 ? undefined : end)
}
/** The node -e script on the one line of a section that names `marker`. */
const scriptOn = (text, marker) => {
  const lines = text.split('\n').filter((l) => l.includes(marker) && l.includes("| node -e '"))
  assert.equal(lines.length, 1, `one command names ${marker}`)
  return lines[0].match(/\| node -e '([^']*)'/)[1]
}
const run = (script, input, ...args) => {
  const r = spawnSync(process.execPath, ['-e', script, ...args], { input, encoding: 'utf8' })
  return { out: r.stdout, all: r.stdout + r.stderr, status: r.status }
}
const SECRET = 'zz-secret-payload'

test('V-U38 (confirmation nit 3): the waiting-proposals command prints id, class and time only — never an answer it did not expect', () => {
  const list = scriptOn(section('V-U38'), '/proposals?status=waiting')
  const ok = run(list, JSON.stringify({ proposals: [{ id: '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5', actionClass: 'zztest_class', waitingSince: '2026-10-06T07:00:00.000Z', payload: { note: SECRET }, actor: 'zztest-person' }] }))
  assert.equal(ok.out, '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5 zztest_class 2026-10-06T07:00:00.000Z\n')
  assert.equal(run(list, '{"error":"unauthorized"}').out, 'unauthorized\n', "the Worker's own error is said")
  for (const odd of [
    JSON.stringify({ proposals: { [SECRET]: { payload: SECRET } }, note: SECRET }), // proposals not a list
    JSON.stringify({ items: [{ payload: SECRET }] }), // another shape
    JSON.stringify({ error: { detail: SECRET } }), // an error that is not a string
    `${SECRET} is not json`, // not JSON at all: a parse error quotes the start of its input
    '',
  ]) {
    const r = run(list, odd)
    assert.ok(!r.all.includes(SECRET), `nothing of an unexpected answer is printed: ${r.all}`)
    assert.equal(r.out, 'unexpected answer\n')
  }
})

test('V-U38: the gate_passed command prints time, type, skill and result for that gate only — never an actor, a payload or an unexpected answer', () => {
  const scan = scriptOn(section('V-U38'), '/ledger/scan?since=')
  const ID = '0d5e7a3c-1b2f-4c6d-8e9f-a0b1c2d3e4f5'
  const ev = (event_type, payload, at) => ({ at, event_type, skill: 'approval-layer', actor: 'zztest-person', payload })
  const ok = run(scan, JSON.stringify({ events: [ev('gate_waiting', { gate: `approval:${ID}`, note: SECRET }, 't1'), ev('gate_passed', { gate: `approval:${ID}`, result: 'rejected' }, 't2'), ev('gate_waiting', { gate: 'approval:other' }, 't3'), null, { payload: null }], rows: [] }), ID)
  assert.equal(ok.out, 't1 gate_waiting approval-layer \nt2 gate_passed approval-layer rejected\n')
  assert.ok(!ok.all.includes('zztest-person') && !ok.all.includes(SECRET), 'no actor, no payload')
  assert.equal(run(scan, '{"error":"unauthorized"}', ID).out, 'unauthorized\n')
  for (const odd of [JSON.stringify({ events: SECRET }), JSON.stringify({ rows: [{ notes: SECRET }] }), `${SECRET} is not json`]) {
    const r = run(scan, odd, ID)
    assert.ok(!r.all.includes(SECRET), `nothing of an unexpected answer is printed: ${r.all}`)
    assert.equal(r.out, 'unexpected answer\n')
  }
})
