// Agent World — U16, the PA's backstop (review 5, 2026-10-05), through the harness: the ledger scan collects every actor
// in the window, and an answer from the Worker that names one of them as a person is withheld before the page sees it.
// A stand-in Worker on loopback; its own file because the harness reads its config at import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const substrate = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/substrate.zztest.json'), 'utf8'))
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/ask.synthetic.json'), 'utf8'))
const now = new Date().toISOString()
const RUN = 'a1a1a1a1-0000-4000-8000-0000000000aa'
const ev = (id, event_type, actor, payload = {}) => ({ id, run_id: RUN, at: now, event_type, skill: 'zztest-approver', trigger: 'cowork_scheduled', client: 'ZZTEST Client', project: null, actor, payload })
const events = [
  ev('e1', 'run_started', 'cowork', { run_class: 'A_gather_sync_check_propose' }),
  ev('e2', 'gate_waiting', 'zztest-approver:propose', { gate: 'ZZTEST gate', surface: 'pending_approval', ref_url: 'https://airtable.com/appZZ/tblZZ/recZZ' }),
  ev('e3', 'gate_passed', 'Zed Zztestperson', { gate: 'ZZTEST gate', surface: 'pending_approval', ref_url: 'https://airtable.com/appZZ/tblZZ/recZZ', result: 'approved' }),
  ev('e4', 'run_completed', 'world', { outcome: 'success' }),
  // confirmation review 2: what a real window also holds — system actors, the live capture's scrubbed placeholder, the
  // seed, a trigger and a client written as actors — and one more person, Christoffer
  { ...ev('e5', 'run_started', 'actor'), run_id: 'b2b2b2b2-0000-4000-8000-0000000000bb', client: 'ZZTEST Town', trigger: 'cowork_manual' },
  { ...ev('e6', 'gate_waiting', 'coordinator', { gate: 'ZZTEST gate 2', surface: 'decision', ref_url: 'https://www.notion.so/zztest' }), run_id: 'b2b2b2b2-0000-4000-8000-0000000000bb', client: 'ZZTEST Town' },
  { ...ev('e7', 'gate_passed', 'christoffer', { gate: 'ZZTEST gate 2', surface: 'decision', ref_url: 'https://www.notion.so/zztest', result: 'approved' }), run_id: 'b2b2b2b2-0000-4000-8000-0000000000bb', client: 'ZZTEST Town' },
  { ...ev('e8', 'run_completed', 'session_hook', { outcome: 'success' }), run_id: 'b2b2b2b2-0000-4000-8000-0000000000bb', client: 'ZZTEST Town' },
  ev('e9', 'artifact_registered', 'zztest-seed', { title: 'ZZTEST artifact' }),
  ev('e10', 'artifact_registered', 'cowork_manual', { title: 'ZZTEST artifact 2' }),
  ev('e11', 'artifact_registered', 'ZZTEST Town', { title: 'ZZTEST artifact 3' }),
]

test('the scan collects every actor; an answer naming one as a person is withheld — places, skills and machine actors are not people', { timeout: 15000 }, async () => {
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
    process.env.EVENTS_BEARER_TOKEN = 'zztest-bearer-backstop'
    process.env.WORLD_OVERLAY_PORT = '0'
    process.env.WORLD_STREAM = '0'
    const { default: harness, _internals } = await import(path.join(root, 'server/harnesses/compass.mjs'))
    await harness.scanThreads()
    assert.deepEqual([..._internals.lastScan().actors].sort(), ['ZZTEST Town', 'Zed Zztestperson', 'actor', 'christoffer', 'coordinator', 'cowork', 'cowork_manual', 'session_hook', 'world', 'zztest-approver:propose', 'zztest-seed'], 'every actor in the window, the taps\' included')
    const ask = (text) => ((answer = text), _internals.ask.ask({ question: 'What is waiting here?', context: { town: 'ZZTEST Client' } }))

    const named = await ask('ZZTEST Client has one open gate. Zed Zztestperson approved the last one.')
    assert.equal(named.status, 200)
    assert.deepEqual([named.body.refused, named.body.reason, named.body.withheld, named.body.answer, named.body.based_on], [true, 'named_person', true, 'Withheld: it named a person.', []])
    assert.equal(named.body.run_id, cases.answer.body.run_id, 'the ask\'s own run stays, so it can be found on the Worker')
    assert.ok(!JSON.stringify(named.body).includes('Zztestperson'), 'no text of the answer reaches the page')

    // confirmation review 2: the person is still withheld, by first name and possessive
    const christoffer = await ask("Alpha waits on Christoffer's approval.")
    assert.deepEqual([christoffer.body.reason, christoffer.body.answer], ['named_person', 'Withheld: it named a person.'])
    for (const fine of [
      'ZZTEST Client has one open gate, from zztest-approver; the world shows it on the Pending Approval surface.',
      'The cowork run finished; the Worker recorded it.',
      'zztest-approver:propose is waiting.',
      // system actors and names the world knows are words here, not people (2ea5ded withheld the last four)
      'The Cowork job ran at 05:30.',
      'Agent World shows two open gates.',
      'ZZTEST Town has 2 open gates',
      'Actor fields are never shown on the map.',
      'The Coordinator posted it; the Session_hook closed it; the cowork_manual trigger fired once.',
    ]) {
      const ok = await ask(fine)
      assert.equal(ok.body.reason, undefined, `${fine} — places, skills and machine actors are not people`)
      assert.equal(ok.body.answer, fine)
    }
  } finally {
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
  }
})
