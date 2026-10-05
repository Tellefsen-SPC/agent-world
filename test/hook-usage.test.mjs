// Agent World — the hook's usage sum (.claude/hooks/ledger.sh usage_json; U35, aligned 2026-10-05 with the template's
// summariseUsage and its reviewer's fix). A session transcript and its subagents' transcripts, de-duplicated on
// message id across all of them in one map (last occurrence wins); decoys around them; the totals worked out by hand
// below. Offline: dry runs and fixtures only.
//
// Hand count for test/fixtures/hook-usage/zztest-session.jsonl + zztest-session/subagents/agent-{a,b}.jsonl:
//   msg_P1  opus   in 10  out 100  cc 1000  cr 5000  5m 600 1h 400  — in the session AND copied into both subagent files
//                                                                     (a fork opens with its parent's messages): counted ONCE
//   msg_P2  opus   in 20  out 50   cc 0     cr 6000  5m 0   1h 0    — streamed: the partial (out 5) is replaced by the final
//   msg_CUT        a line cut off mid-write: skipped
//   p1             a progress line that says "usage": not an assistant entry, skipped
//   a-noid  opus   in 1   out 2    cc 3     cr 4                    — no message.id: keyed by its uuid
//   msg_P3  opus   in 0   out 10   cc 0     cr 0                    — "999", -5 and null are not counts: 0
//   msg_SYN <synthetic>, all zeros: no model, no by_model line — and the session's last named model stays opus
//   msg_A1  haiku  in 300 out 40   cc 200   cr 0     5m 200 1h 0
//   msg_B1  haiku  in 100 out 60   cc 0     cr 900
//   totals         in 431 out 262  cc 1203  cr 11904 5m 800 1h 400   (per-file de-dup would read in 451, out 462)
//   by_model       opus  in 31  out 162 cc 1003 cr 11004 5m 600 1h 400 · haiku in 400 out 100 cc 200 cr 900 5m 200 1h 0
//   decoys (never read): subagents/agent-a.meta.json, subagents/nested/agent-c.jsonl, the session dir's sibling.jsonl,
//                        and — made here — a symlink, a folder named *.jsonl, an unreadable file. Each carries 1,000,000s.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const hook = path.join(root, '.claude/hooks/ledger.sh')
const fixture = path.join(root, 'test/fixtures/hook-usage')
// a deadline of our own on every call: if the hook's ever regresses, the stalled-transcript test fails instead of hanging CI
const usage = (p, env = {}) => spawnSync('bash', [hook, 'usage', p], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10_000 })
const sum = (p, env) => {
  const out = usage(p, env).stdout.trim()
  return out ? JSON.parse(out) : null
}

const EXPECTED = {
  input_tokens: 431,
  output_tokens: 262,
  cache_creation_input_tokens: 1203,
  cache_read_input_tokens: 11904,
  cache_creation: { ephemeral_5m_input_tokens: 800, ephemeral_1h_input_tokens: 400 },
  model: 'claude-opus-5',
  source: 'transcript',
  by_model: {
    'claude-opus-5': { input_tokens: 31, output_tokens: 162, cache_creation_input_tokens: 1003, cache_read_input_tokens: 11004, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } },
    'claude-haiku-4-5': { input_tokens: 400, output_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 } },
  },
  subagents: 2,
}

/** A scratch copy of the fixture, with the decoys git cannot carry well: a symlink, a folder named *.jsonl, an unreadable file. */
function scratch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'))
  fs.cpSync(fixture, tmp, { recursive: true })
  const sub = path.join(tmp, 'zztest-session', 'subagents')
  fs.symlinkSync(path.join(tmp, 'decoy-target.jsonl'), path.join(sub, 'link.jsonl'))
  fs.mkdirSync(path.join(sub, 'folder.jsonl'))
  fs.copyFileSync(path.join(tmp, 'decoy-target.jsonl'), path.join(sub, 'folder.jsonl', 'inside.jsonl'))
  fs.copyFileSync(path.join(tmp, 'decoy-target.jsonl'), path.join(sub, 'unreadable.jsonl'))
  fs.chmodSync(path.join(sub, 'unreadable.jsonl'), 0o000)
  return { tmp, session: path.join(tmp, 'zztest-session.jsonl'), sub }
}
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('hook usage: the session and its subagents, de-duplicated across every file at once — a forked copy of the parent\'s message counts once; the totals by hand', () => {
  assert.deepEqual(sum(path.join(fixture, 'zztest-session.jsonl')), EXPECTED)
  // the original six keys keep their meaning: the four totals, the session's model, the source
  const got = sum(path.join(fixture, 'zztest-session.jsonl'))
  assert.notEqual(got.input_tokens, 451, 'per-file de-duplication would count msg_P1 three times')
  const byModel = Object.values(got.by_model)
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    assert.equal(byModel.reduce((a, m) => a + m[k], 0), got[k], `by_model adds up to the total ${k}`)
  }
  assert.deepEqual(Object.keys(got.by_model), ['claude-opus-5', 'claude-haiku-4-5'], 'most output first')
  assert.ok(Buffer.byteLength(JSON.stringify(got)) < 8 * 1024)
  assert.ok(!JSON.stringify(got).includes('decoy') && !JSON.stringify(got).includes('1000000'), 'no decoy was read')
  const keys = (o) => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : [])
  for (const k of ['content', 'text', 'transcript', 'body', 'prompt', 'email', 'actor']) assert.ok(!keys(got).includes(k), `no ${k} key`)
})

test('hook usage: that folder only, regular .jsonl files only — a symlink, a folder named *.jsonl, a subfolder, a .meta.json, a sibling and an unreadable file are never read', () => {
  const s = scratch()
  try {
    const got = sum(s.session)
    if (asRoot) return // root reads the chmod 000 file; the rest of the check needs an ordinary user
    assert.deepEqual(got, EXPECTED)
    // a subagents folder that is itself a symlink is not followed
    const moved = path.join(s.tmp, 'elsewhere')
    fs.renameSync(s.sub, moved)
    fs.symlinkSync(moved, s.sub)
    const noSubs = sum(s.session)
    assert.equal(noSubs.subagents, undefined)
    assert.equal(noSubs.input_tokens, 31, 'only the session\'s own replies')
  } finally {
    for (const p of [path.join(s.sub, 'unreadable.jsonl'), path.join(s.tmp, 'elsewhere', 'unreadable.jsonl')]) {
      try { fs.chmodSync(p, 0o600) } catch { /* the folder was moved, or not */ }
    }
    fs.rmSync(s.tmp, { recursive: true, force: true })
  }
})

test('hook usage: no session transcript means nothing, even with subagent files beside it; a session that used nothing but whose subagents did reads theirs, with the subagent\'s model', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'))
  try {
    fs.cpSync(path.join(fixture, 'zztest-session'), path.join(tmp, 'zztest-session'), { recursive: true })
    assert.equal(usage(path.join(tmp, 'zztest-session.jsonl')).stdout.trim(), '', 'not a subagent-only sum passed off as the session\'s')
    fs.writeFileSync(path.join(tmp, 'zztest-session.jsonl'), '{"type":"user","message":{"content":"hi"}}\n')
    const got = sum(path.join(tmp, 'zztest-session.jsonl'))
    assert.equal(got.model, 'claude-haiku-4-5', 'the session named no model: the last subagent\'s')
    assert.equal(got.subagents, 2)
    assert.equal(got.input_tokens, 10 + 300 + 100, 'msg_P1 once (from the subagents), A1, B1')
    // used nothing at all → nothing (not measured is not zero)
    fs.rmSync(path.join(tmp, 'zztest-session'), { recursive: true })
    assert.equal(usage(path.join(tmp, 'zztest-session.jsonl')).stdout.trim(), '')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('hook usage: past ten models, the nine with the most output stay and the rest are summed as "other"; a reply with no model is "unknown"', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'))
  try {
    const line = (id, model, out) => JSON.stringify({ type: 'assistant', uuid: id, message: { id, ...(model ? { model } : {}), usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
    const lines = Array.from({ length: 12 }, (_, i) => line(`m${i + 1}`, `zztest-model-${String(i + 1).padStart(2, '0')}`, 10 * (i + 1)))
    fs.writeFileSync(path.join(tmp, 's.jsonl'), lines.join('\n') + '\n')
    const got = sum(path.join(tmp, 's.jsonl'))
    assert.equal(Object.keys(got.by_model).length, 10)
    assert.deepEqual(Object.keys(got.by_model).slice(0, 9), [12, 11, 10, 9, 8, 7, 6, 5, 4].map((n) => `zztest-model-${String(n).padStart(2, '0')}`))
    assert.deepEqual(got.by_model.other, { input_tokens: 3, output_tokens: 30 + 20 + 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
    assert.equal(got.output_tokens, 780)
    assert.equal(got.model, 'zztest-model-12', 'the last model in file order')
    fs.writeFileSync(path.join(tmp, 'u.jsonl'), [line('x1', 'zztest-model-a', 5), line('x2', '', 7), line('x3', '<synthetic>', 9)].join('\n') + '\n')
    const unk = sum(path.join(tmp, 'u.jsonl'))
    assert.deepEqual(Object.keys(unk.by_model), ['unknown', 'zztest-model-a'], 'the unnamed and the synthetic reply that did work sum as unknown')
    assert.equal(unk.by_model.unknown.output_tokens, 16)
    assert.equal(unk.model, 'zztest-model-a', '<synthetic> is never the model')
    // one model only: no by_model, the six keys as before
    assert.deepEqual(Object.keys(sum(path.join(root, 'test/fixtures/hook-usage/decoy-target.jsonl'))), ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'model', 'source'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('hook usage: a sum past its deadline is dropped — `usage` prints nothing and says so; SessionEnd posts run_completed without usage and with usage_skipped "timeout", in time', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-usage-'))
  const fifo = path.join(tmp, 'zztest-stalled.jsonl')
  try {
    // a transcript that never finishes reading: a named pipe nobody writes to
    execFileSync('mkfifo', [fifo])
    const t0 = Date.now()
    const r = usage(fifo, { LEDGER_USAGE_TIMEOUT: '0.3' })
    assert.equal(r.stdout.trim(), '')
    assert.match(r.stderr, /usage skipped: timeout/)
    assert.ok(!/Terminated/.test(r.stderr), 'no job notice')
    assert.ok(Date.now() - t0 < 2500, 'it gave up at the deadline')
    const env = { ...process.env, HOOK_DRY_RUN: '1', LEDGER_STATE_DIR: path.join(tmp, 'state'), LEDGER_RUN_ID_FILE: path.join(tmp, 'run_id'), LEDGER_PROJECTS_DIR: path.join(tmp, 'projects'), LEDGER_USAGE_TIMEOUT: '0.3' }
    const run = (event, input) => execFileSync('bash', [hook, event], { encoding: 'utf8', env, input: JSON.stringify(input), timeout: 10_000 }).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    run('run_started', { session_id: 'zztest-hook-slow', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/zz' })
    const t1 = Date.now()
    const done = run('run_completed', { session_id: 'zztest-hook-slow', hook_event_name: 'SessionEnd', transcript_path: fifo }).find((e) => e.event_type === 'run_completed')
    assert.deepEqual(done.payload, { outcome: 'success', usage_skipped: 'timeout' })
    assert.ok(Date.now() - t1 < 2500, 'the run ended well inside the 10 s SessionEnd budget')
    // and the default deadline is 3 s
    assert.match(fs.readFileSync(hook, 'utf8'), /\$\{LEDGER_USAGE_TIMEOUT:-3\}/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
