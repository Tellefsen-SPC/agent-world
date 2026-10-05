#!/usr/bin/env node
/**
 * The session's token usage, for run_completed (U35, ES-4.13) — a port of the template's count, so a run reads the same
 * in either ledger: sovereign-stack-template `origin/main` (9ba1baf) `.claude/hooks/lib.mjs` (accumulateFile,
 * subagentTranscripts, sessionUsage, usageDeadlineMs) and `.claude/hooks/ledger-body.mjs` (usageAccumulator,
 * summariseUsage). Decided 2026-10-05 (review of aw-pa-panel, item 3): this replaces the jq sum in ledger.sh, which
 * could not stop part-way through a long line and re-implemented the rule in another language.
 *
 *   node .claude/hooks/usage.mjs <transcript.jsonl> [--until <ms since the epoch>]
 *     prints one line: {"usage": {…} | null, "skipped": "timeout" | null, "elapsed_ms": n}
 *     --until (ledger.sh's, not the template's): stop by then even when the deadline is later — SessionEnd's budget is
 *     wall-clock from the hook's start, so a slow start on a loaded machine shortens the sum, never the post.
 *
 * The rule, as the template's:
 *   - the files: the session transcript, then <transcript minus .jsonl>/subagents/*.jsonl — that folder only, regular
 *     .jsonl files only (no .meta.json, no .jsonl.bak, no symlink, no subfolder), in byte order. No readable session
 *     transcript → null (never a subagent-only sum passed off as the session's); an unreadable subagent file is left out;
 *   - one difference, deliberate (review item 10): a <session>/ or subagents/ folder that is itself a symlink is not
 *     followed. The template follows one (readdirSync does); Claude Code never makes one, and a link there could pull
 *     another session's transcripts into this one's count;
 *   - lines split on "\n" only (never U+2028/U+2029, which JSON allows raw in a string), a trailing "\r" dropped,
 *     read in chunks and linear in a line's length; a line that does not parse is skipped;
 *   - replies: assistant entries whose message.usage is an object, keyed by message.id (else the entry's uuid), the
 *     last occurrence winning — within a file (a streamed reply is written several times) and across all of the
 *     session's files in one map (a forked subagent's transcript opens with copies of its parent's replies);
 *   - a counter that is not a non-negative number counts 0; "<synthetic>" is never a model;
 *   - the shape: input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, model (the last the
 *     session's own transcript names, else the last a subagent's names), source "transcript" — the six keys as U35
 *     built them — plus cache_creation {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens} when recorded (it divides
 *     cache_creation_input_tokens), by_model when more than one model did any work (most output first; past ten, nine
 *     and "other"; no model → "unknown"), and subagents: how many subagent files were counted, when any were. Null when
 *     every counter sums to 0: "not measured" and "used nothing" are different facts.
 *
 * A deadline (6 s by default; HOOK_USAGE_DEADLINE_MS, a whole number of ms, at most 8 s; anything else is the default),
 * checked once per chunk and once per line, and by a timer for a read that stalls. Past it: usage null, skipped
 * "timeout" — ledger.sh then posts run_completed without usage and says why. Numbers and model ids only: never a line
 * of a transcript, a prompt or a tool input.
 */
import { createReadStream, lstatSync, readdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const USAGE_COUNTERS = Object.freeze(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])
/** The cache-write split by lifetime, under usage.cache_creation, where present. */
export const CACHE_LIFETIMES = Object.freeze(['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'])
/** More models than this in one session, and the rest are summed as "other". */
const MAX_MODELS = 10

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
/** A model id worth reporting, or null. `<synthetic>` is what no model produced. */
const namedModel = (model) => (typeof model === 'string' && model && model !== '<synthetic>' ? model : null)

/** One transcript file's model replies, a line at a time: message id (else entry uuid) → { usage, model }, the last write winning. */
export function usageAccumulator() {
  const replies = new Map()
  let model = null
  const accumulator = {
    add(line) {
      if (typeof line !== 'string' || !line.includes('"usage"')) return // cheap first: most lines are not replies
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return
      const message = entry.message
      if (!message || typeof message !== 'object') return
      const usage = message.usage
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return
      const id = message.id !== undefined && message.id !== null && message.id !== false ? message.id : (entry.uuid ?? null)
      replies.set(JSON.stringify(id), { usage, model: namedModel(message.model) })
      if (namedModel(message.model)) model = message.model
    },
    /** Each distinct reply in this file, as [id, { usage, model }], in file order. */
    entries: () => [...replies.entries()],
    replies: () => [...replies.values()],
    lastModel: () => model,
    result: () => summariseUsage([accumulator]),
  }
  return accumulator
}

const emptyCounters = () => Object.fromEntries(USAGE_COUNTERS.map((key) => [key, 0]))
function addReply(total, usage) {
  for (const key of USAGE_COUNTERS) total.counters[key] += count(usage[key])
  const split = usage.cache_creation
  if (split && typeof split === 'object' && !Array.isArray(split)) {
    total.split ??= Object.fromEntries(CACHE_LIFETIMES.map((key) => [key, 0]))
    for (const key of CACHE_LIFETIMES) total.split[key] += count(split[key])
  }
}
const render = (total) => ({ ...total.counters, ...(total.split ? { cache_creation: total.split } : {}) })

/** The usage object from one or more transcripts' accumulators — the session's own first, then its subagents'. */
export function summariseUsage(transcripts) {
  const total = { counters: emptyCounters(), split: null }
  const perModel = new Map()
  // one map for the whole session, in reading order: a reply in several files is one reply, the last occurrence winning
  const session = new Map()
  for (const transcript of transcripts) for (const [id, reply] of transcript.entries()) session.set(id, reply)
  for (const { usage, model } of session.values()) {
    addReply(total, usage)
    if (USAGE_COUNTERS.every((key) => count(usage[key]) === 0)) continue // a reply that used nothing names no model
    if (!perModel.has(model)) perModel.set(model, { counters: emptyCounters(), split: null })
    addReply(perModel.get(model), usage)
  }
  const sum = USAGE_COUNTERS.reduce((acc, key) => acc + total.counters[key], 0)
  if (sum <= 0) return null
  const [own, ...subagents] = transcripts
  const model = own?.lastModel() ?? subagents.map((t) => t.lastModel()).filter(Boolean).pop() ?? null
  const out = { ...render(total), model, source: 'transcript' }
  if (perModel.size > 1) {
    const ranked = [...perModel.entries()].sort((a, b) => b[1].counters.output_tokens - a[1].counters.output_tokens)
    const keep = ranked.length > MAX_MODELS ? ranked.slice(0, MAX_MODELS - 1) : ranked
    const byModel = Object.fromEntries(keep.map(([name, t]) => [name ?? 'unknown', render(t)]))
    const rest = ranked.slice(keep.length)
    if (rest.length > 0) {
      const other = { counters: emptyCounters(), split: null }
      for (const [, t] of rest) addReply(other, render(t))
      byModel.other = render(other)
    }
    out.by_model = byModel
  }
  if (subagents.length > 0) out.subagents = subagents.length
  return out
}

/** The usage object for one transcript held in memory, or null. */
export function usageFromTranscript(text) {
  if (typeof text !== 'string' || text === '') return null
  const usage = usageAccumulator()
  for (const line of text.split('\n')) usage.add(line.endsWith('\r') ? line.slice(0, -1) : line)
  return usage.result()
}

/** Thrown inside the reader when the deadline has passed. */
class UsageDeadline extends Error {}

/** One file, streamed into its own accumulator; throws if it cannot be read, or (via `check`) past the deadline. */
async function accumulateFile(file, check = () => {}) {
  const usage = usageAccumulator()
  const input = createReadStream(file, { encoding: 'utf8' })
  const take = (line) => {
    check()
    usage.add(line.endsWith('\r') ? line.slice(0, -1) : line)
  }
  let pending = [] // the pieces of the line still waiting for its newline
  try {
    for await (const chunk of input) {
      check()
      let start = 0
      let newline = chunk.indexOf('\n')
      while (newline !== -1) {
        const piece = chunk.slice(start, newline)
        if (pending.length === 0) take(piece)
        else {
          pending.push(piece)
          const line = pending.join('')
          pending = []
          take(line)
        }
        start = newline + 1
        newline = chunk.indexOf('\n', start)
      }
      if (start < chunk.length) pending.push(chunk.slice(start))
    }
    if (pending.length > 0) take(pending.join(''))
  } finally {
    input.destroy()
  }
  return usage
}

/** A real folder, not a link to one (review item 10). */
const isRealDir = (dir) => {
  try {
    return lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** <session>/subagents/*.jsonl for a session transcript: regular files only, that folder only, neither folder a symlink. */
export function subagentTranscripts(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return []
  const sessionDir = transcriptPath.slice(0, -'.jsonl'.length)
  const dir = path.join(sessionDir, 'subagents')
  if (!isRealDir(sessionDir) || !isRealDir(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => path.join(dir, entry.name))
      .sort()
  } catch {
    return []
  }
}

/** How long the sum may take by default, and the most an override may give it (ledger.sh keeps the post inside 10 s). */
export const USAGE_DEADLINE_MS = 6000
export const MAX_USAGE_DEADLINE_MS = 8000
/** HOOK_USAGE_DEADLINE_MS when it is a whole number of zero or more, capped at 8 s; the default otherwise. */
export function usageDeadlineMs(env = process.env) {
  const raw = String(env.HOOK_USAGE_DEADLINE_MS ?? '').trim()
  if (!/^\d+$/.test(raw)) return USAGE_DEADLINE_MS
  return Math.min(Number.parseInt(raw, 10), MAX_USAGE_DEADLINE_MS)
}

/** { usage, skipped }: usage null when there is nothing to count; skipped "timeout" past the deadline. Never throws. */
export async function sessionUsage(transcriptPath, { deadlineMs = USAGE_DEADLINE_MS, now = Date.now } = {}) {
  if (typeof transcriptPath !== 'string' || transcriptPath.trim() === '') return { usage: null, skipped: null }
  const limited = Number.isFinite(deadlineMs)
  const deadline = limited ? now() + deadlineMs : Infinity
  let expired = false
  const check = () => {
    if (expired || now() > deadline) {
      expired = true
      throw new UsageDeadline()
    }
  }
  const work = (async () => {
    let own
    try {
      own = await accumulateFile(transcriptPath, check)
    } catch (error) {
      if (error instanceof UsageDeadline) throw error
      return null
    }
    const subagents = []
    for (const file of subagentTranscripts(transcriptPath)) {
      try {
        subagents.push(await accumulateFile(file, check))
      } catch (error) {
        if (error instanceof UsageDeadline) throw error
      }
    }
    check()
    return summariseUsage([own, ...subagents])
  })()
  let timer
  const timeout = limited
    ? new Promise((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve('timeout')
        }, Math.max(0, deadlineMs))
        timer.unref?.()
      })
    : null
  try {
    const result = await (timeout ? Promise.race([work, timeout]) : work)
    if (result === 'timeout') return { usage: null, skipped: 'timeout' }
    return { usage: result, skipped: null }
  } catch (error) {
    if (error instanceof UsageDeadline) return { usage: null, skipped: 'timeout' }
    return { usage: null, skipped: null }
  } finally {
    clearTimeout(timer)
    work.catch(() => {})
  }
}

/** `sessionUsage` with no deadline: the usage object, or null. */
export async function transcriptUsage(transcriptPath) {
  return (await sessionUsage(transcriptPath, { deadlineMs: Infinity })).usage
}

// The command line: one line of JSON on stdout, exit 0. After a timeout the read that stalled can hold one of Node's I/O
// threads (a FIFO's open blocks), and Node's exit waits for it — measured: process.exit hung past 4 s, while a hard kill
// ended in a third of a second. ledger.sh waits for this process, so after a timeout it ends itself at once; it wrote
// nothing but its one line, and holds nothing that needs closing.
/** The deadline for this run: the configured one, cut to what is left before `until` (ms since the epoch) when given. */
export function effectiveDeadlineMs(env = process.env, until = NaN, now = Date.now()) {
  const own = usageDeadlineMs(env)
  return Number.isFinite(until) ? Math.max(0, Math.min(own, until - now)) : own
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--until')
  const until = at > 2 ? Number(process.argv[at + 1]) : NaN
  const { usage, skipped } = await sessionUsage(process.argv[2], { deadlineMs: effectiveDeadlineMs(process.env, until) })
  writeSync(1, `${JSON.stringify({ usage, skipped, elapsed_ms: Math.round(performance.now()) })}\n`)
  if (skipped === 'timeout') process.kill(process.pid, 'SIGKILL')
  process.exit(0)
}
