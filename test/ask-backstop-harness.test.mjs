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
    assert.deepEqual([..._internals.lastScan().actors].sort(), ['Zed Zztestperson', 'cowork', 'world', 'zztest-approver:propose'], 'every actor in the window, the tap\'s included')
    const ask = (text) => ((answer = text), _internals.ask.ask({ question: 'What is waiting here?', context: { town: 'ZZTEST Client' } }))

    const named = await ask('ZZTEST Client has one open gate. Zed Zztestperson approved the last one.')
    assert.equal(named.status, 200)
    assert.deepEqual([named.body.refused, named.body.reason, named.body.withheld, named.body.answer, named.body.based_on], [true, 'named_person', true, 'Withheld: it named a person.', []])
    assert.equal(named.body.run_id, cases.answer.body.run_id, 'the ask\'s own run stays, so it can be found on the Worker')
    assert.ok(!JSON.stringify(named.body).includes('Zztestperson'), 'no text of the answer reaches the page')

    for (const fine of [
      'ZZTEST Client has one open gate, from zztest-approver; the world shows it on the Pending Approval surface.',
      'The cowork run finished; the Worker recorded it.',
      'zztest-approver:propose is waiting.',
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
