// Agent World — the session's usage for run_completed (U35), counted by .claude/hooks/usage.mjs, the template's count
// ported (sovereign-stack-template origin/main 9ba1baf, .claude/hooks/lib.mjs + ledger-body.mjs), and SessionEnd's one
// POST (review item 3, 2026-10-05). Offline: fixtures, dry runs, and loopback stand-ins for the Worker.
//
// Two fixture sets:
//  - test/fixtures/template/ — the template's own fixtures, copied unchanged. EXPECTED and EXPECTED_OWN below are the
//    template's hand-worked numbers (its tests/session-end.test.ts), so this count and the template's are the same
//    count on the same files (checked once against the template's code too: identical on every fixture here).
//  - test/fixtures/hook-usage/ — this repo's: the same reply in the session and in two subagent files, with decoys.
//    Hand count: msg_P1 (opus: in 10, out 100, cc 1000, cr 5000, 5m 600, 1h 400) in all three files counts once;
//    msg_P2 streamed (out 5, then 50 — the last wins); a cut-off line and a progress line that says "usage" are
//    skipped; a reply with no id is keyed by its uuid (in 1, out 2, cc 3, cr 4); "999", -5 and null count 0
//    (msg_P3: out 10); <synthetic> is no model; haiku msg_A1 (in 300, out 40, cc 200, 5m 200) and msg_B1 (in 100,
//    out 60, cr 900). Totals in 431, out 262, cc 1203, cr 11904, split 800/400 — per-file de-dup would read 451.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const hook = path.join(root, '.claude/hooks/ledger.sh')
const usageScript = path.join(root, '.claude/hooks/usage.mjs')
const u = await import(usageScript)
const TEMPLATE = path.join(root, 'test/fixtures/template/zztest-transcript.jsonl')
const OURS = path.join(root, 'test/fixtures/hook-usage/zztest-session.jsonl')

/** The template's hand-worked numbers (tests/session-end.test.ts on its main), copied. */
const EARLY = { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } }
const EXPECTED_OWN = {
  input_tokens: 18, output_tokens: 77, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1600,
  cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
  model: 'zztest-model-late', source: 'transcript',
  by_model: { 'zztest-model-early': EARLY, 'zztest-model-late': { input_tokens: 8, output_tokens: 27, cache_creation_input_tokens: 0, cache_read_input_tokens: 1600 } },
}
const EXPECTED = {
  input_tokens: 27, output_tokens: 110, cache_creation_input_tokens: 1200, cache_read_input_tokens: 1660,
  cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 600 },
  model: 'zztest-model-late', source: 'transcript',
  by_model: {
    'zztest-model-early': EARLY,
    'zztest-model-late': { input_tokens: 10, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 1610 },
    'zztest-model-small': { input_tokens: 7, output_tokens: 30, cache_creation_input_tokens: 200, cache_read_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } },
  },
  subagents: 2,
}
const OURS_EXPECTED = {
  input_tokens: 431, output_tokens: 262, cache_creation_input_tokens: 1203, cache_read_input_tokens: 11904,
  cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 400 },
  model: 'claude-opus-5', source: 'transcript',
  by_model: {
    'claude-opus-5': { input_tokens: 31, output_tokens: 162, cache_creation_input_tokens: 1003, cache_read_input_tokens: 11004, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } },
    'claude-haiku-4-5': { input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } },
  },
  subagents: 2,
}

const viaHook = (p, env = {}) => spawnSync('bash', [hook, 'usage', p], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15_000 })
const sumOf = (p, env) => {
  const out = viaHook(p, env).stdout.trim()
  return out ? JSON.parse(out) : null
}
const cli = (p, env = {}) => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [usageScript, p], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15_000 })
  return { ...JSON.parse(r.stdout.trim()), ms: Date.now() - t0, signal: r.signal }
}
const reply = (id, usage, model = 'zztest-model') => JSON.stringify({ type: 'assistant', uuid: `zz-${id}-${Math.random()}`, message: { id, model, usage } })
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'))

test('hook usage: the template\'s fixtures give the template\'s hand-worked totals — the same count in either repo, through usage.mjs and through ledger.sh', async () => {
  assert.deepEqual(await u.transcriptUsage(TEMPLATE), EXPECTED)
  assert.deepEqual(u.usageFromTranscript(fs.readFileSync(TEMPLATE, 'utf8')), EXPECTED_OWN, 'the session\'s own transcript alone')
  assert.deepEqual(sumOf(TEMPLATE), EXPECTED, 'ledger.sh prints the same object')
  assert.deepEqual(u.subagentTranscripts(TEMPLATE).map((f) => path.basename(f)), ['agent-zztest-a.jsonl', 'agent-zztest-b.jsonl'], 'no .meta.json, no .jsonl.bak, no subfolder, nothing beside the folder')
})

test('hook usage: this repo\'s fixture — a reply copied into two subagent files counts once; streamed replies, cut lines, odd counters and <synthetic> as worked out by hand', async () => {
  const got = await u.transcriptUsage(OURS)
  assert.deepEqual(got, OURS_EXPECTED)
  assert.notEqual(got.input_tokens, 451, 'per-file de-duplication would count msg_P1 three times')
  for (const k of u.USAGE_COUNTERS) assert.equal(Object.values(got.by_model).reduce((a, m) => a + m[k], 0), got[k], `by_model adds up to ${k}`)
  assert.deepEqual(sumOf(OURS), OURS_EXPECTED)
  assert.ok(Buffer.byteLength(JSON.stringify(got)) < 8 * 1024)
  const keys = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : [])
  for (const k of ['content', 'text', 'transcript', 'body', 'prompt', 'email', 'actor']) assert.ok(!keys(got).includes(k), `no ${k} key`)
  // the U35 fixture: the six keys as U35 built them, and by_model since two models worked
  assert.deepEqual(Object.keys(sumOf(path.join(root, 'test/fixtures/m2b-transcript.jsonl'))), ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'model', 'source', 'by_model'])
})

test('hook usage (review item 10): no symlink is followed — not a subagent file, not the subagents folder, not the <session> folder', async () => {
  const dir = tmpdir()
  try {
    const session = path.join(dir, 'zz.jsonl')
    fs.writeFileSync(session, `${reply('m1', { output_tokens: 1 })}\n`)
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(path.join(elsewhere, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(elsewhere, 'subagents', 'agent-x.jsonl'), `${reply('m9', { output_tokens: 999999 })}\n`)
    fs.writeFileSync(path.join(dir, 'outside.jsonl'), `${reply('m8', { output_tokens: 888888 })}\n`)
    // a symlinked <session> folder
    fs.symlinkSync(elsewhere, path.join(dir, 'zz'))
    assert.deepEqual(u.subagentTranscripts(session), [])
    assert.equal((await u.transcriptUsage(session)).output_tokens, 1)
    // a real <session> folder whose subagents folder is a symlink
    fs.unlinkSync(path.join(dir, 'zz'))
    fs.mkdirSync(path.join(dir, 'zz'))
    fs.symlinkSync(path.join(elsewhere, 'subagents'), path.join(dir, 'zz', 'subagents'))
    assert.deepEqual(u.subagentTranscripts(session), [])
    // a real subagents folder holding a symlinked file
    fs.unlinkSync(path.join(dir, 'zz', 'subagents'))
    fs.mkdirSync(path.join(dir, 'zz', 'subagents'))
    fs.symlinkSync(path.join(dir, 'outside.jsonl'), path.join(dir, 'zz', 'subagents', 'agent-link.jsonl'))
    fs.writeFileSync(path.join(dir, 'zz', 'subagents', 'agent-real.jsonl'), `${reply('m2', { output_tokens: 2 })}\n`)
    assert.deepEqual(u.subagentTranscripts(session).map((f) => path.basename(f)), ['agent-real.jsonl'])
    assert.equal((await u.transcriptUsage(session)).output_tokens, 3)
    assert.equal(sumOf(session).output_tokens, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hook usage: lines break on \\n only — U+2028 inside a reply, CRLF, a last line with no newline; one 16 MB line is read well inside the deadline', async () => {
  const dir = tmpdir()
  try {
    const f = path.join(dir, 'lines.jsonl')
    const withSep = JSON.stringify({ type: 'assistant', uuid: 'a', message: { id: 'm1', model: 'zz', content: [{ type: 'text', text: 'one two three' }], usage: { output_tokens: 7 } } })
    fs.writeFileSync(f, `${withSep}\r\n${reply('m2', { output_tokens: 5 })}`)
    assert.equal((await u.transcriptUsage(f)).output_tokens, 12)
    const big = path.join(dir, 'big.jsonl')
    fs.writeFileSync(big, `${JSON.stringify({ type: 'assistant', uuid: 'b', message: { id: 'mb', model: 'zz', content: 'x'.repeat(16 * 1024 * 1024), usage: { output_tokens: 3 } } })}\n`)
    const r = cli(big)
    assert.deepEqual([r.skipped, r.usage?.output_tokens], [null, 3], 'linear in the line: well inside 6 s')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hook usage: no session transcript is no usage, whatever its subagents hold; nothing to count is no usage', async () => {
  const dir = tmpdir()
  try {
    fs.mkdirSync(path.join(dir, 'gone', 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'gone', 'subagents', 'agent-x.jsonl'), `${reply('m1', { output_tokens: 5 })}\n`)
    assert.equal(await u.transcriptUsage(path.join(dir, 'gone.jsonl')), null)
    assert.equal(viaHook(path.join(dir, 'gone.jsonl')).stdout.trim(), '')
    for (const v of [undefined, null, '', '   ', 42]) assert.equal(await u.transcriptUsage(v), null, String(v))
    assert.equal(viaHook('').stdout.trim(), '')
    assert.deepEqual(await u.sessionUsage(path.join(dir, 'nothing.jsonl')), { usage: null, skipped: null }, 'missing is not a timeout')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hook usage: the deadline — 6 s by default, an override capped at 8 s, anything else the default; a stalled read gives up on time and the script ends at once', () => {
  assert.deepEqual([u.USAGE_DEADLINE_MS, u.MAX_USAGE_DEADLINE_MS], [6000, 8000])
  assert.equal(u.usageDeadlineMs({}), 6000)
  assert.equal(u.usageDeadlineMs({ HOOK_USAGE_DEADLINE_MS: '300' }), 300)
  assert.equal(u.usageDeadlineMs({ HOOK_USAGE_DEADLINE_MS: '0' }), 0)
  for (const big of ['8000', '8001', '60000', '99999999999999999999']) assert.equal(u.usageDeadlineMs({ HOOK_USAGE_DEADLINE_MS: big }), 8000, big)
  for (const bad of ['', 'abc', '-5', '1.5', '6s']) assert.equal(u.usageDeadlineMs({ HOOK_USAGE_DEADLINE_MS: bad }), 6000, `"${bad}"`)
  const dir = tmpdir()
  try {
    // a FIFO nobody writes to: its open blocks, as a transcript on a stalled disk would; only the timer ends the sum.
    // Node's exit waits for that blocked open, so after a timeout the script ends itself (it holds nothing to close).
    const fifo = path.join(dir, 'stalled.jsonl')
    execFileSync('mkfifo', [fifo])
    const r = cli(fifo, { HOOK_USAGE_DEADLINE_MS: '300' })
    assert.deepEqual([r.usage, r.skipped], [null, 'timeout'])
    assert.ok(r.ms < 3000, `ended ${r.ms} ms after it started`)
    const viaShell = viaHook(fifo, { HOOK_USAGE_DEADLINE_MS: '300' })
    assert.equal(viaShell.stdout.trim(), '')
    assert.match(viaShell.stderr, /usage skipped: timeout/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** A Worker that accepts every request and never answers; keeps each body. */
async function silentWorker() {
  const bodies = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => bodies.push(b))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/events`, bodies, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}
/** A session that started and holds one open permission prompt, then SessionEnd against `worker` — timed. */
function sessionEndWithOpenGate(worker, transcript, extraEnv = {}) {
  const tmp = tmpdir()
  // LEDGER_SKIP_DOTENV: these hooks really post, so a developer's .env can never point them at the real Worker
  const base = { ...process.env, LEDGER_SKIP_DOTENV: '1', LEDGER_STATE_DIR: path.join(tmp, 'state'), LEDGER_RUN_ID_FILE: path.join(tmp, 'run_id'), LEDGER_PROJECTS_DIR: path.join(tmp, 'projects'), EVENTS_URL: worker.url, EVENTS_BEARER_TOKEN: 'zztest-silent-token' }
  delete base.HOOK_DRY_RUN
  delete base.LEDGER_DRY_RUN
  const sid = 'zztest-silent-session'
  const dry = { ...base, HOOK_DRY_RUN: '1' }
  execFileSync('bash', [hook, 'run_started'], { env: dry, input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz' }), timeout: 10_000 })
  execFileSync('bash', [hook, 'gate_waiting'], { env: dry, input: JSON.stringify({ session_id: sid, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'zz' } }), timeout: 10_000 })
  const t0 = Date.now()
  const r = spawnSync('bash', [hook, 'run_completed'], { env: { ...base, ...extraEnv }, input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', transcript_path: transcript }), timeout: 20_000 })
  const ms = Date.now() - t0
  fs.rmSync(tmp, { recursive: true, force: true })
  return { ms, status: r.status }
}
const settingsTimeoutMs = () => JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).hooks.SessionEnd[0].hooks[0].timeout * 1000

test('SessionEnd (review item 3): the open gate\'s close and run_completed go in ONE POST with a 2 s limit — a Worker that never answers costs 2 s, not 4 s a gate', { timeout: 30_000 }, async () => {
  const worker = await silentWorker()
  try {
    const { ms, status } = sessionEndWithOpenGate(worker, TEMPLATE)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(status, 0)
    assert.equal(worker.bodies.length, 1, 'one request')
    const { events } = JSON.parse(worker.bodies[0])
    assert.deepEqual(events.map((e) => e.event_type), ['gate_passed', 'run_completed'])
    assert.equal(events[0].payload.result, 'rejected')
    assert.deepEqual(events[1].payload.usage, EXPECTED)
    assert.ok(ms < 3500, `${ms} ms (the 2 s post and the sum; the jq hook took 8.1 s here)`)
  } finally {
    await worker.close()
  }
})

test('SessionEnd (review item 3): a stalled transcript and a silent Worker still end inside the hook\'s 10 s — run_completed posted, without usage, saying why', { timeout: 30_000 }, async () => {
  const worker = await silentWorker()
  const dir = tmpdir()
  try {
    const fifo = path.join(dir, 'stalled.jsonl')
    execFileSync('mkfifo', [fifo])
    const { ms, status } = sessionEndWithOpenGate(worker, fifo)
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(status, 0)
    assert.equal(worker.bodies.length, 1)
    const done = JSON.parse(worker.bodies[0]).events.find((e) => e.event_type === 'run_completed')
    assert.deepEqual(done.payload, { outcome: 'success', usage_skipped: 'timeout' })
    assert.ok(ms < settingsTimeoutMs(), `${ms} ms against SessionEnd's ${settingsTimeoutMs()} ms (the jq hook took 11.1 s here)`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    await worker.close()
  }
})

test('SessionEnd: the budget adds up at the cap — an 8 s sum leaves the post 1 s, and the two fit the hook\'s 10 s with room for bash and node to start', () => {
  const postMax = (elapsed) => Number(execFileSync('bash', ['-c', `eval "$(sed -n '/^post_max()/,/^}/p' "${hook}")"; post_max '{"usage":null,"skipped":"timeout","elapsed_ms":${elapsed}}'`], { encoding: 'utf8' }).trim())
  assert.equal(postMax(100), 2)
  assert.equal(postMax(6100), 2)
  assert.equal(postMax(8050), 0.95)
  assert.equal(postMax(9900), 0.5, 'never under half a second')
  assert.ok(u.MAX_USAGE_DEADLINE_MS + 100 + postMax(u.MAX_USAGE_DEADLINE_MS + 100) + 500 <= settingsTimeoutMs(), 'at the cap: sum + post + starts fit')
  const text = fs.readFileSync(hook, 'utf8')
  assert.match(text, /LEDGER_SKIP_DOTENV/, 'tests that really post can never read .env')
  assert.ok(!/jq[^\n]*input_tokens/.test(text), 'no second implementation of the count in jq')
})

test('SessionEnd: the POST gets what is left — after a long sum, curl\'s limit is the budget less the sum, never the full 2 s', { timeout: 30_000 }, () => {
  const dir = tmpdir()
  try {
    // a stand-in curl that records its arguments: the limit is what this checks, not the network
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    const argsFile = path.join(dir, 'curl-args')
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 })
    const fifo = path.join(dir, 'stalled.jsonl')
    execFileSync('mkfifo', [fifo])
    const base = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LEDGER_SKIP_DOTENV: '1', LEDGER_STATE_DIR: path.join(dir, 'state'), LEDGER_RUN_ID_FILE: path.join(dir, 'run_id'), LEDGER_PROJECTS_DIR: path.join(dir, 'projects'), EVENTS_URL: 'http://127.0.0.1:9/events', EVENTS_BEARER_TOKEN: 'zztest-stub-token' }
    delete base.HOOK_DRY_RUN
    const sid = 'zztest-stub-session'
    execFileSync('bash', [hook, 'run_started'], { env: { ...base, HOOK_DRY_RUN: '1' }, input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz' }), timeout: 10_000 })
    // a 1.5 s sum against a 2.5 s budget: about 1 s is left for the post
    execFileSync('bash', [hook, 'run_completed'], { env: { ...base, HOOK_USAGE_DEADLINE_MS: '1500', LEDGER_POST_BUDGET_MS: '2500' }, input: JSON.stringify({ session_id: sid, hook_event_name: 'SessionEnd', transcript_path: fifo }), timeout: 15_000 })
    const args = fs.readFileSync(argsFile, 'utf8').split('\n')
    const limit = Number(args[args.indexOf('-m') + 1])
    assert.ok(limit >= 0.5 && limit < 1.2, `curl -m ${limit}: the budget less the sum`)
    assert.ok(!args.join(' ').includes('zztest-stub-token') || args.some((a) => a === 'Authorization: Bearer zztest-stub-token'), 'the token only in its header')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
