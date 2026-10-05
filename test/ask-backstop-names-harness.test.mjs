// Agent World — U16, the PA's backstop (review of ed7aba9, 2026-10-05), through the harness: the names that are never
// people come from the substrate only — Active ops_clients, ops_skills, WORLD_COMPANIES names and keys, the pack's rooms,
// the campus — plus the Worker's fixed trigger list. Never from ledger events: anyone holding the events bearer can write
// one, and an honest event can carry a person's name in `client`. A stand-in Worker on loopback; its own file because the
// harness reads its config at import.
//
// The place names below are made up and deliberately carry no ZZTEST prefix: anything starting "zztest" is skipped by the
// prefix rule on its own, which would hide whether the substrate collection did the work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const base = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/substrate.zztest.json'), 'utf8'))
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/ask.synthetic.json'), 'utf8'))
// the substrate: the ZZTEST fixture plus a company, an Active client and an inactive one with plain names
const substrate = {
  ...base,
  world_companies: { ...base.world_companies, companies: [...base.world_companies.companies, { key: 'fixture-harbour', name: 'Fixture Harbour Co', role: 'venture', status: 'active', clients: [], substrate: null, world_pack: 'neutral' }] },
  clients: [...base.clients, { id: '00000000-0000-4000-8000-0000000000f1', name: 'Fixture Freight', status: 'Active' }, { id: '00000000-0000-4000-8000-0000000000f2', name: 'Fixture Former', status: 'Former' }],
}
const now = new Date().toISOString()
let n = 0
const ev = (run, event_type, actor, extra = {}, payload = {}) => ({ id: `n${++n}`, run_id: run, at: now, event_type, skill: 'zztest-approver', trigger: 'cowork_scheduled', client: 'ZZTEST Client', project: null, actor, payload, ...extra })
const R1 = 'c1c1c1c1-0000-4000-8000-0000000000c1'
const R2 = 'c2c2c2c2-0000-4000-8000-0000000000c2'
const R3 = 'c3c3c3c3-0000-4000-8000-0000000000c3'
const events = [
  // planted (or honest) events whose client and skill are a person's name — they must not make the person "known"
  ev(R1, 'run_started', 'cowork', { client: 'Christoffer', skill: 'Christoffer' }),
  ev(R1, 'gate_waiting', 'cowork', { client: 'Christoffer', skill: 'Christoffer' }, { gate: 'ZZTEST gate', surface: 'pending_approval', ref_url: 'https://airtable.com/appZZ/tblZZ/recZZ' }),
  ev(R1, 'gate_passed', 'christoffer', { client: 'Christoffer', skill: 'Christoffer' }, { gate: 'ZZTEST gate', surface: 'pending_approval', ref_url: 'https://airtable.com/appZZ/tblZZ/recZZ', result: 'approved' }),
  // actors equal to substrate names: a company key, an Active client, a pack room (id and name)
  ev(R2, 'run_started', 'fixture-harbour', { client: 'Fixture Freight' }),
  ev(R2, 'artifact_registered', 'Fixture Freight', { client: 'Fixture Freight' }, { title: 'ZZTEST artifact' }),
  ev(R2, 'artifact_registered', 'research-lab', { client: 'Fixture Freight' }, { title: 'ZZTEST artifact 2' }),
  ev(R2, 'run_completed', 'research lab', { client: 'Fixture Freight' }, { outcome: 'success' }),
  // an inactive client seen only in events, used as an actor: not known, so withheld — the safe direction
  ev(R3, 'run_started', 'Fixture Former', { client: 'Fixture Former' }),
  // trigger values written as actors: known only through TRIGGERS, the Worker's fixed list (neither is a system actor)
  ev(R3, 'artifact_registered', 'chat', { client: 'Fixture Former' }, { title: 'ZZTEST artifact 3' }),
  ev(R3, 'artifact_registered', 'claude_project', { client: 'Fixture Former' }, { title: 'ZZTEST artifact 4' }),
]

test('known names come from the substrate only: an event-planted client or skill never unblocks a person; a company key, an Active client and a room pass as places', { timeout: 15000 }, async () => {
  let answer = ''
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/ledger/scan') return send(200, { events, rows: [] })
    if (url.pathname === '/world/substrate') return send(200, substrate)
    if (url.pathname === '/ask') return send(200, { ...cases.answer.body, answer })
    send(404, { error: 'not found' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    for (const k of Object.keys(process.env)) if (/^(NOTION_|AIRTABLE_TOKEN$|WORLD_STREAM$|WORLD_ASK_BEARER$)/.test(k)) delete process.env[k]
    process.env.EVENTS_URL = `http://127.0.0.1:${server.address().port}/events`
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer-names'
    process.env.WORLD_OVERLAY_PORT = '0'
    process.env.WORLD_STREAM = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    await harness.scanThreads()
    const ask = async (text) => ((answer = text), (await _internals.ask.ask({ question: 'What is waiting here?' })).body)
    const withheld = (b) => b.reason === 'named_person'

    // 1 — the planted client and skill "Christoffer" do not make him a place: the name is still withheld
    assert.ok(withheld(await ask("Alpha waits on Christoffer's approval.")), 'an event-planted client or skill never unblocks a person')

    // 2 — actors equal to substrate names are places, each through its own collection
    for (const [what, text] of [
      ['an Active client (ops_clients)', 'Fixture Freight has one open gate.'],
      ['a company key (WORLD_COMPANIES)', 'fixture-harbour has no runs yet.'],
      ['a pack room id', 'research-lab is on the first ring.'],
      ['a pack room name', 'The research lab holds two briefs.'],
      // the Worker's trigger values as words: only TRIGGERS makes these known (review of 45ddada)
      ['a trigger, chat', 'Chat runs are answered on the Worker.'],
      ['a trigger, claude_project', 'claude_project runs open the Claude Project.'],
    ]) {
      const b = await ask(text)
      assert.ok(!withheld(b), `${what}: "${text}" names no person`)
      assert.equal(b.answer, text)
    }

    // 3 — an inactive client seen only in events is not a known name: an answer naming it is withheld (the safe side)
    assert.ok(withheld(await ask('Fixture Former still has a run.')), 'a name only events vouch for is not known')
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})
