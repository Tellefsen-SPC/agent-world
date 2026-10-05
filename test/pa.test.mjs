// Agent World — U16, the PA panel (ES-4.6): the panel's rules in overlay/pa.mjs — who sees it, what it can ask about,
// what it says for each status — and the static guarantees: its one network call is the sidecar's /ask, and no
// overlay file holds a bearer. Pure; no Worker, no model.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const pa = await import(path.join(root, 'overlay/pa.mjs'))
const { PRESETS, makeViewer } = await import(path.join(root, 'server/harnesses/compass/viewer.mjs'))
const { parseQuestion } = await import(path.join(root, 'server/harnesses/compass/ask.mjs'))
const cases = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/ask.synthetic.json'), 'utf8'))

const RUN = 'A1A1A1A1-0000-4000-8000-000000000001'
const towns = ['ZZTEST Client', 'ZZTEST Client 2']
const viewerJson = (preset) => JSON.parse(JSON.stringify({ preset, capabilities: makeViewer({ preset }).capabilities }))
const open = { ...pa.initialPa(), open: true }
/** Words that would invite a question about a person (Annex III). */
const PERSON = /\b(who|whom|whose|person|people|someone|team ?mate|member|staff|employee|developer|engineer|approver|reviewer|owner of|rank|ranking|score|perform\w*|productiv\w*|blame|fault|slowest|fastest|best|worst|lazy|lazier)\b/i

test('U16: the panel exists only for a viewer holding `ask` — the Owner; every other preset gets null (no element), even with the panel "open"', () => {
  const subjects = pa.subjectsFor({})
  assert.ok(pa.panelModel({ viewer: viewerJson('owner'), state: open, subjects }), 'the Owner sees it')
  assert.equal(pa.panelModel({ viewer: viewerJson('owner'), state: pa.initialPa(), subjects }), null, 'closed is nothing')
  for (const preset of Object.keys(PRESETS).filter((p) => p !== 'owner')) {
    assert.equal(pa.mayAsk(viewerJson(preset)), false, preset)
    assert.equal(pa.panelModel({ viewer: viewerJson(preset), state: open, subjects }), null, preset)
  }
  assert.equal(pa.panelModel({ viewer: { preset: 'owner' }, state: open, subjects }), null, 'a preset name is not the capability')
  assert.equal(pa.panelModel({ viewer: null, state: open, subjects }), null)
})

test('U16: subjects — a run in a town (run_id + town), its town, the firm; a run in a campus room asks by run only; a surface request asks by its town', () => {
  const run = { id: RUN, kind: 'request', request: 'gate', skill: 'zztest-approver', project: 'ZZTEST Client', title: '? Approve in Airtable' }
  const s = pa.subjectsFor({ thread: run, towns })
  assert.deepEqual(s.map((x) => x.kind), ['run', 'town', 'firm'])
  assert.deepEqual(s[0].context, { run_id: RUN.toLowerCase(), town: 'ZZTEST Client' })
  assert.equal(s[0].label, 'this run · zztest-approver')
  assert.deepEqual(s[1].context, { town: 'ZZTEST Client' })
  assert.deepEqual(s[2].context, {})
  const campus = pa.subjectsFor({ thread: { ...run, project: 'Board Room' }, towns })
  assert.deepEqual(campus.map((x) => x.kind), ['run', 'firm'])
  assert.deepEqual(campus[0].context, { run_id: RUN.toLowerCase() }, 'a room is not a town')
  const paRow = pa.subjectsFor({ thread: { id: 'pa:recZZTEST', kind: 'request', request: 'pa', skill: 'Pending Approval', project: 'ZZTEST Client' }, towns })
  assert.deepEqual(paRow.map((x) => [x.kind, x.context]), [['request', { town: 'ZZTEST Client' }], ['town', { town: 'ZZTEST Client' }], ['firm', {}]])
  assert.ok(!paRow.some((x) => 'run_id' in x.context), 'a surface request has no run id to send')
})

test('U16: subjects — a project fixture offers the project and its milestones (open first, at most six, the Notion link when there is one), then its town; the town card offers its town; nothing selected asks the firm', () => {
  const ms = [
    { id: 'm1', name: 'Done one', done: true, url: 'https://www.notion.so/zztest-m1' },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, name: `Open ${i}`, done: false, url: i === 0 ? 'https://www.notion.so/zztest-o0' : '' })),
  ]
  const fixture = { id: 'project:zz', kind: 'fixture', fixture: 'project', title: 'ZZTEST project', project: 'ZZTEST Client', milestones: ms }
  const s = pa.subjectsFor({ thread: fixture, towns, noun: 'town' })
  assert.deepEqual(s.map((x) => x.kind), ['project', 'milestone', 'milestone', 'milestone', 'milestone', 'milestone', 'milestone', 'town', 'firm'])
  assert.deepEqual(s[0].context, { project: 'ZZTEST project', town: 'ZZTEST Client' })
  assert.deepEqual(s[1].context, { project: 'ZZTEST project', town: 'ZZTEST Client', milestone: 'https://www.notion.so/zztest-o0' }, 'the link, so the Worker can read the page')
  assert.equal(s[2].context.milestone, 'o1', 'no link: the id')
  assert.ok(!s.some((x) => x.label === 'milestone · Done one'), 'open milestones first; the done one is past the sixth')
  assert.deepEqual(pa.subjectsFor({ town: 'ZZTEST Client 2', towns }).map((x) => [x.kind, x.context]), [['town', { town: 'ZZTEST Client 2' }], ['firm', {}]])
  assert.deepEqual(pa.subjectsFor({}).map((x) => x.kind), ['firm'])
  assert.deepEqual(pa.subjectsFor({ town: 'Not a town', towns }).map((x) => x.kind), ['firm'], 'a name that is no town is not sent as one')
})

test('U16 / Annex III: no subject is a person — an actor or approver on the thread never reaches a label or the context; every context key is one the Worker takes', () => {
  const run = { id: RUN, kind: 'request', skill: 'zztest-approver', project: 'ZZTEST Client', actor: 'Zed Person', approvedBy: 'Zed Person', agent: { actor: 'Zed Person' } }
  const all = [...pa.subjectsFor({ thread: run, towns }), ...pa.subjectsFor({ thread: { kind: 'fixture', fixture: 'project', id: 'p', title: 'ZZTEST project', project: 'ZZTEST Client', actor: 'Zed Person', milestones: [] }, towns })]
  assert.ok(!JSON.stringify(all).includes('Zed Person'))
  for (const s of all) {
    for (const k of Object.keys(s.context)) assert.ok(['run_id', 'town', 'project', 'milestone'].includes(k), k)
    assert.ok(!PERSON.test(s.label.replace(run.skill, 'the skill')), s.label) // a skill's own name is not a person
    const body = pa.requestBody('what is waiting here?', s)
    assert.equal(parseQuestion(body).error, undefined, `${s.id}: the sidecar takes the body as built`)
  }
  // a place the Worker would refuse (a quote, too long) is left out rather than sent
  assert.deepEqual(pa.subjectsFor({ thread: { ...run, project: 'ZZTEST "quoted"' }, towns: ['ZZTEST "quoted"'] })[0].context, { run_id: RUN.toLowerCase() })
  assert.equal(pa.cleanText('x'.repeat(201)), '')
})

test('U16 / Annex III: the placeholder, the hint and every suggestion ask about places and runs — none invites a question about a person', () => {
  const texts = [pa.PLACEHOLDER, pa.HINT.replace('It never ranks, scores or compares people.', ''), ...['run', 'request', 'town', 'project', 'milestone', 'firm', 'unknown'].flatMap((k) => pa.suggestionsFor(k))]
  for (const t of texts) assert.ok(!PERSON.test(t), `invites a person question: ${t}`)
  assert.match(pa.PLACEHOLDER, /run/)
  assert.match(pa.PLACEHOLDER, /town|milestone/)
  assert.match(pa.HINT, /never ranks, scores or compares people/, 'the panel says what it will not do')
})

test('U16: the question bounds match the sidecar and the Worker; the body is {question, context} and nothing else', () => {
  assert.match(pa.questionProblem(''), /Type a question/)
  assert.match(pa.questionProblem('   '), /Type a question/)
  assert.match(pa.questionProblem('x'.repeat(1001)), /At most 1000/)
  assert.match(pa.questionProblem('bell\u0007'), /control/)
  assert.equal(pa.questionProblem('x'.repeat(1000)), '')
  assert.equal(pa.questionProblem('two\nlines\twith a tab'), '')
  const s = pa.subjectsFor({ town: 'ZZTEST Client', towns })[0]
  assert.deepEqual(pa.requestBody('  which gates are open here?  ', s), { question: 'which gates are open here?', context: { town: 'ZZTEST Client' } })
})

test('U16: an answer shows its text without the trailing Based on line, the based_on refs (read and not read), and the run and model it came from', () => {
  const v = pa.viewOf({ status: 200, body: cases.answer.body })
  assert.equal(v.tone, 'answer')
  assert.equal(v.text, 'ZZTEST Alpha waits on the Pending Approval gate ZZTEST gate (https://airtable.com/appZZTEST/tblZZTEST/recZZTEST).')
  assert.deepEqual(v.basedOn.map((r) => r.label), cases.answer.body.based_on.map((b) => b.label))
  assert.equal(v.basedOn.at(-1).note, 'a name, not a Notion page id or link', 'named, not read — and why')
  assert.equal(v.basedOn[0].note, '')
  assert.equal(v.meta, 'run b2b2b2b2 · claude-sonnet-5 · 2,000 in · 150 out')
  assert.deepEqual(v.notes, [])
  const cut = pa.viewOf({ status: 200, body: { ...cases.answer.body, truncated: true, ledger: { run_started: true, run_completed: false, row: null } } })
  assert.deepEqual(cut.notes, ['Cut to fit: the substrate or the answer reached its limit.', "The ledger missed this ask's end; it is still an answer."])
  assert.deepEqual(pa.splitBasedOn('no line here'), { text: 'no line here', line: '' })
  const many = pa.basedOnRows(Array.from({ length: 15 }, (_, i) => ({ ref: `r${i}`, label: `ref ${i}`, read: true })))
  assert.equal(many.length, 13)
  assert.equal(many.at(-1).label, 'and 3 more')
})

test('U16: a refusal says plainly that the PA does not judge people, and where it was refused — the question check, the model, or the answer check (withheld)', () => {
  const guard = pa.viewOf({ status: 200, body: cases.refusal_guard.body })
  assert.equal(guard.tone, 'refused')
  assert.equal(guard.title, 'Not answered: the PA does not judge people (Annex III)')
  assert.equal(guard.text, cases.refusal_guard.body.answer, 'the refusal text as the Worker wrote it')
  assert.match(guard.detail, /before any model was called; nothing was spent/)
  assert.match(pa.viewOf({ status: 200, body: cases.refusal_withheld.body }).detail, /withheld/)
  assert.match(pa.viewOf({ status: 200, body: { ...cases.refusal_guard.body, model: 'claude-sonnet-5' } }).detail, /model declined/)
})

test('U16: every other status in words — off (503, 404, this machine), the budget with its wait, the provider and substrate failures, the bearer, the side port gone; never a bare code', () => {
  const budget = pa.viewOf({ status: 429, body: { ...cases.budget.body, retry_after: 15120 } })
  assert.deepEqual([budget.tone, budget.title], ['budget', "The PA's budget for today is spent"])
  assert.equal(budget.wait, 'Try again in 4 h 12 min: the budget resets at 00:00 UTC (04:00 Muscat).')
  assert.match(budget.detail, /ASK_DAILY_LIMIT/)
  const off = pa.viewOf({ status: 503, body: cases.not_configured.body })
  assert.deepEqual([off.tone, off.title, off.detail], ['off', 'PA not switched on', 'ASK_PROVIDER is not set on the Worker'])
  assert.deepEqual([pa.viewOf({ status: 404, body: { error: 'not found' } }).title, pa.viewOf({ status: 404, body: {} }).text], ['PA not switched on', 'The Worker has no /ask route yet: U16W is not deployed.'])
  assert.equal(pa.viewOf({ status: 503, body: { error: 'world_not_configured', detail: 'x' } }).title, 'PA not switched on on this machine')
  const expect = {
    provider_failed: 'The model provider failed',
    provider_timeout: 'The model did not answer in time',
    out_of_time: 'Compass ran out of time reading the ledger',
    substrate_unavailable: 'The Worker could not read the substrate',
    ledger_unavailable: 'The run ledger did not record the ask',
    budget_unavailable: "The Worker could not check today's budget",
    worker_unreachable: 'The Worker could not be reached',
    bad_answer: 'The Worker answered in a shape the panel does not know',
  }
  for (const [error, title] of Object.entries(expect)) {
    const v = pa.viewOf({ status: 502, body: { error, detail: 'the Worker said why' } })
    assert.deepEqual([v.tone, v.title, v.detail], ['error', title, 'the Worker said why'], error)
  }
  assert.equal(pa.viewOf({ status: 502, body: cases.provider_failed.body }).meta, 'run e5e5e5e5 · claude-sonnet-5', 'a failed ask names its own run')
  assert.equal(pa.viewOf({ status: 401, body: { error: 'unauthorized' } }).title, "The Worker refused this machine's token")
  assert.equal(pa.viewOf({ status: 504, body: { error: 'worker_timeout' } }).title, 'The Worker did not answer in time')
  assert.equal(pa.viewOf({ status: 405, body: { error: 'method not allowed' } }).title, 'The Worker refused how it was asked')
  assert.equal(pa.viewOf({ status: 415, body: {} }).title, 'The question was not sent as JSON')
  assert.equal(pa.viewOf({ status: 409, body: { error: 'ask_in_flight' } }).title, 'One question at a time')
  assert.equal(pa.viewOf({ status: 413, body: {} }).title, 'The question is too long')
  assert.equal(pa.viewOf({ status: 400, body: { error: 'context.run_id must be a uuid' } }).text, 'context.run_id must be a uuid')
  assert.equal(pa.viewOf({ status: 403, body: { error: 'The PA answers the Owner only' } }).title, 'The PA answers the Owner only')
  assert.equal(pa.viewOf({ status: 0, body: { error: 'sidecar_unreachable' } }).title, 'The side port did not answer')
  assert.equal(pa.viewOf({ status: 0, body: { error: 'page_timeout' } }).title, 'No answer within 60 s')
  assert.equal(pa.viewOf({ status: 418, body: { error: 'teapot' } }).title, 'The ask failed (HTTP 418)')
  for (const status of [0, 200, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503, 504]) {
    const v = pa.viewOf({ status, body: status === 200 ? cases.answer.body : { error: 'x' } })
    assert.ok(v.title && !/^\d+$/.test(v.title) && v.text, `status ${status} reads as words`)
  }
})

test('U16: waits read as a person reads them', () => {
  assert.equal(pa.formatWait(40), '40 s')
  assert.equal(pa.formatWait(720), '12 min')
  assert.equal(pa.formatWait(3600), '1 h')
  assert.equal(pa.formatWait(15120), '4 h 12 min')
  assert.equal(pa.formatWait(-5), '0 s')
})

test('U16: the panel state — one ask at a time, never an empty one; the answer keeps the subject it was asked about', () => {
  const subject = pa.subjectsFor({ town: 'ZZTEST Client', towns })[0]
  let s = pa.paReduce(undefined, { type: 'open', subjectId: '' })
  assert.equal(s.open, true)
  assert.equal(pa.paReduce(s, { type: 'send', subject }), s, 'an empty question is not sent')
  s = pa.paReduce(s, { type: 'type', text: 'which gates are open here?' })
  const sent = pa.paReduce(s, { type: 'send', subject })
  assert.deepEqual([sent.pending, sent.askedAbout, sent.result], [true, 'town · ZZTEST Client', null])
  assert.equal(pa.paReduce(sent, { type: 'send', subject }), sent, 'not twice')
  const m = pa.panelModel({ viewer: viewerJson('owner'), state: sent, subjects: [subject] })
  assert.deepEqual([m.canSend, m.sendLabel, m.pending], [false, 'Asking…', true])
  const done = pa.paReduce(sent, { type: 'result', status: 200, body: cases.answer.body })
  assert.equal(done.pending, false)
  assert.equal(pa.panelModel({ viewer: viewerJson('owner'), state: done, subjects: [] }).view.tone, 'answer')
  assert.equal(pa.paReduce(done, { type: 'result', status: 500, body: {} }), done, 'a late result with nothing pending changes nothing')
  assert.equal(pa.paReduce(done, { type: 'close' }).open, false)
  assert.equal(pa.paReduce(pa.paReduce(done, { type: 'close' }), { type: 'toggle' }).open, true)
  const model = pa.panelModel({ viewer: viewerJson('owner'), state: pa.paReduce(done, { type: 'type', text: 'x'.repeat(1001) }), subjects: [subject] })
  assert.deepEqual([model.canSend, /At most 1000/.test(model.problem)], [false, true])
  assert.equal(pa.panelModel({ viewer: viewerJson('owner'), state: pa.paReduce(done, { type: 'subject', id: 'gone' }), subjects: [subject] }).subject.id, subject.id, 'a subject that went away falls back to the most specific')
})

test('U16: the panel\'s one network call is the sidecar\'s /ask — pa.mjs makes none, no overlay file holds a bearer or names the Worker, and the fork still names no model endpoint', () => {
  const code = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const paCode = code('overlay/pa.mjs')
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(/.test(paCode), 'pa.mjs is pure')
  const zones = code('overlay/zones.mjs')
  assert.deepEqual([...zones.matchAll(/\/ask\b/g)].length, 1, 'one /ask in the overlay')
  assert.match(zones, /fetch\(`\$\{SIDECAR\}\/ask`, \{ method: 'POST'/)
  const main = code('overlay/main.js')
  assert.ok(!/\/ask\b/.test(main), 'main.js calls askPa, never a URL of its own')
  assert.match(main, /await askPa\(body\)/)
  for (const f of fs.readdirSync(path.join(root, 'overlay')).filter((n) => /\.m?js$/.test(n))) {
    const text = code(`overlay/${f}`)
    // a setting's name in a sentence ("set WORLD_ASK_BEARER …") is help text; a header, a token prefix, the Worker's host or an env read is not
    assert.ok(!/Authorization\s*['":]|['"`]Bearer\s|workers\.dev|process\.env|import\.meta\.env/.test(text), `overlay/${f} holds a bearer or names the Worker`)
  }
})

test('U16 (review 1): an English-only refusal says so in plain words and never says Annex III — from the question check and from the answer check', () => {
  const q = pa.viewOf({ status: 200, body: cases.english_only_question.body })
  assert.deepEqual([q.tone, q.title], ['refused', 'Not answered: the PA takes questions in English only for now'])
  assert.equal(q.text, cases.english_only_question.body.answer, 'the Worker\'s own text')
  assert.match(q.detail, /question check/)
  const a = pa.viewOf({ status: 200, body: cases.english_only_answer.body })
  assert.equal(a.title, 'Not answered: the PA takes questions in English only for now')
  assert.match(a.detail, /checked in English only/)
  for (const v of [q, a]) assert.ok(!/annex/i.test(`${v.title} ${v.detail}`), `no Annex III: ${v.title} · ${v.detail}`)
  assert.match(pa.viewOf({ status: 200, body: cases.refusal_guard.body }).title, /Annex III/, 'an Annex III refusal still says so')
  assert.equal(pa.viewOf({ status: 200, body: { ...cases.refusal_guard.body, reason: undefined } }).title, 'Not answered', 'a refusal with no reason the panel knows: plain, and no Annex III claimed')
})

test('U16 (review 2): every error code the Worker documents (compass-ask docs/ask.md @ 71fecb9) has words of its own — out_of_time included; none falls through to "The ask failed"', () => {
  // copied from the contract's error table; when docs/ask.md adds a code, add it here
  const documented = [
    [400, 'question is required: send {"question": "…", "context": {…}}'],
    [401, 'unauthorized'],
    [405, 'method not allowed'],
    [413, 'body exceeds 8192 bytes'],
    [429, 'ask_budget_exceeded'],
    [503, 'ask_not_configured'],
    [503, 'EVENTS_BEARER_TOKEN is not configured on the Worker'],
    [502, 'budget_unavailable'],
    [502, 'ledger_unavailable'],
    [502, 'substrate_unavailable'],
    [502, 'provider_failed'],
    [502, 'provider_timeout'],
    [502, 'out_of_time'],
  ]
  for (const [status, error] of documented) {
    const v = pa.viewOf({ status, body: { error } })
    assert.ok(!/^The ask failed/.test(v.title), `${status} ${error} has its own title`)
    assert.ok(v.text, `${status} ${error} says what it means`)
  }
  assert.equal(pa.viewOf({ status: 503, body: { error: 'EVENTS_BEARER_TOKEN is not configured on the Worker' } }).detail, 'EVENTS_BEARER_TOKEN is not configured on the Worker', 'a 503 with no detail shows its sentence')
  const ot = pa.viewOf(cases.out_of_time)
  assert.deepEqual([ot.title, ot.meta], ['Compass ran out of time reading the ledger', 'run dadadada'])
  assert.match(ot.text, /nothing was spent.*Ask again/)
  assert.ok(!('provider_empty' in pa.WORKER_502), 'provider_empty is a reason inside provider_failed, not a code')
})

test('U16 (review 8): no timeout says the question stayed on this machine — once sent, the ask may still be running on the Worker', () => {
  for (const r of [{ status: 0, body: { error: 'page_timeout' } }, { status: 0, body: { error: 'sidecar_unreachable' } }, { status: 504, body: { error: 'worker_timeout' } }, { status: 0 }]) {
    const v = pa.viewOf(r)
    assert.ok(!/did not leave this machine|nothing was asked/i.test(`${v.title} ${v.text} ${v.detail}`), JSON.stringify(r))
  }
  assert.match(pa.viewOf({ status: 0, body: { error: 'page_timeout' } }).text, /may still be running on the Worker/)
  assert.match(pa.viewOf({ status: 504, body: { error: 'worker_timeout' } }).text, /may still be running on the Worker/)
})
