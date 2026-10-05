// Agent World — invariants that hold for every unit, every session. `npm test` runs this file.
// 1. src/ is byte-identical to upstream (the fork's seam is one adapter file).
// 2. The fork calls no model: no model endpoint or SDK anywhere outside node_modules. (The PA spends tokens on the
//    Worker, which makes the one model call; the fork only forwards the question — ADR-0008.)
// 3. The adapter never writes to the substrate (static guard; the human checks prove it live). Two non-GETs are
//    allowed, each pinned to one line in one file: Notion's data-source query (a read with a body) and the PA's
//    question to the Worker's POST /ask (U16; the Worker, not the world, records the ask as its own run).
// 4. The registry is exactly [compass].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('src/ is byte-identical to upstream/main', () => {
  let ref
  try {
    ref = sh('git rev-parse --verify upstream/main')
  } catch {
    assert.fail('no upstream/main — add the remote: git remote add upstream https://github.com/jarrenrocks/bot-crossing && git fetch upstream')
  }
  assert.ok(ref)
  // Against the upstream commit this fork is built on — the merge base — not
  // upstream's tip: upstream moving on is not the fork editing src/, and the
  // tip made this test fail for everyone the day upstream committed anything.
  const diff = sh(`git diff --stat ${forkBase()} -- src/`)
  assert.equal(diff, '', `src/ differs from upstream:\n${diff}`)
})

/** The upstream commit the fork is built on. Merging upstream moves it forward. */
const forkBase = () => sh('git merge-base HEAD upstream/main')

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git', 'dist', 'data', 'recordings', 'test', 'assets-src', 'public'].includes(name)) continue
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(m?js|cjs|ts|html|json|sh)$/.test(name)) out.push(p)
  }
  return out
}

test('no model API anywhere in the fork (the fork calls no model; the PA\'s tokens are spent on the Worker)', () => {
  const needles = [/api\.anthropic\.com/, /api\.openai\.com/, /generativelanguage\.googleapis/, /@anthropic-ai\/sdk/, /["']openai["']/, /messages\.create\(/]
  const hits = []
  for (const f of walk(root)) {
    if (path.basename(f) === 'invariants.test.mjs') continue
    const text = fs.readFileSync(f, 'utf8')
    for (const n of needles) if (n.test(text)) hits.push(`${path.relative(root, f)} matches ${n}`)
  }
  assert.deepEqual(hits, [], `model endpoints found:\n${hits.join('\n')}`)
})

test('the adapter never writes: no non-GET request and no supabase-js write chain in server/harnesses/compass*', () => {
  const files = []
  const entry = path.join(root, 'server/harnesses/compass.mjs')
  if (fs.existsSync(entry)) files.push(entry)
  const dir = path.join(root, 'server/harnesses/compass')
  if (fs.existsSync(dir)) walk(dir, files)
  // Two shapes of write: an HTTP verb on a request, or a supabase-js query chain (.from(...).insert/update/upsert/delete/rpc).
  // A Map or Set .delete() is not a write to anything; only chains that start at .from( count.
  const httpNeedles = [/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, /['"](POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]\/rest\//i]
  // The one allowed non-GET: Notion lists a database's rows only through POST /v1/data_sources/<id>/query —
  // a read with a body (filter, sort, page size). Since M2b (B5) compass/notion.mjs makes it, only for an id
  // compass/notion-sources.mjs allows (checked before the request is built), and nothing else may: the file
  // must contain exactly one `.method` assignment, guarded by isAllowed, building only the /query path.
  const ALLOWED_LINE = "init.method = 'POST'"
  const notionQueryOnly = (text) => {
    const lines = text.split('\n')
    const allowed = lines.filter((l) => l.includes(ALLOWED_LINE))
    const assignments = lines.filter((l) => /\.method\s*=/.test(l) || /method:\s*['"]/.test(l))
    const guarded = /isAllowed\(id/.test(text) && text.indexOf('isAllowed(id') < text.indexOf(ALLOWED_LINE)
    if (allowed.length !== 1 || assignments.length !== 1 || !guarded || !/data_sources\/\$\{id\}\/query/.test(text)) return null
    return lines.filter((l) => !l.includes(ALLOWED_LINE)).join('\n') // the rest is checked like every other file
  }
  // The second allowed non-GET (U16W wiring, ES-4.6; docs/adr/0008): the PA's question, POST to the Worker's /ask.
  // It writes nothing the world owns: the Worker records the ask as its own governed run (its events and its
  // ops_skill_runs row), as it records every model call it makes. compass/ask.mjs may hold exactly one method,
  // POST, on exactly one fetch — to cfg.askUrl, verbatim — and no other file may.
  const ASK_LINE = "method: 'POST',"
  const askOnly = (text) => {
    const lines = text.split('\n')
    const methods = lines.filter((l) => /\.method\s*=/.test(l) || /method:\s*['"]/.test(l))
    const fetches = [...text.matchAll(/fetchImpl\s*\(\s*([^,)]+)/g)].map((m) => m[1].trim())
    if (methods.length !== 1 || methods[0].trim() !== ASK_LINE || fetches.length !== 1 || fetches[0] !== 'cfg.askUrl') return null
    return lines.filter((l) => l.trim() !== ASK_LINE).join('\n')
  }
  const chainNeedle = /\.from\([^)]*\)[\s\S]{0,200}?\.(insert|update|upsert|delete|rpc)\(/
  const hits = []
  for (const f of files) {
    let text = fs.readFileSync(f, 'utf8')
    if (path.basename(f) === 'notion.mjs') {
      const rest = notionQueryOnly(text)
      if (rest == null) hits.push('server/harnesses/compass/notion.mjs: more than the one guarded Notion data-source query is written')
      else text = rest
    }
    if (path.basename(f) === 'ask.mjs') {
      const rest = askOnly(text)
      if (rest == null) hits.push('server/harnesses/compass/ask.mjs: more than the one POST of the question to cfg.askUrl')
      else text = rest
    }
    for (const n of httpNeedles) if (n.test(text)) hits.push(`${path.relative(root, f)} matches ${n}`)
    if (/\.method\s*=\s*['"](POST|PUT|PATCH|DELETE)['"]/i.test(text)) hits.push(`${path.relative(root, f)} assigns a write method`)
    if (chainNeedle.test(text)) hits.push(`${path.relative(root, f)} has a supabase-js write chain`)
  }
  assert.deepEqual(hits, [], `write calls found in the adapter:\n${hits.join('\n')}`)
})

test('harness registry is exactly [compass]', async () => {
  const mod = await import(path.join(root, 'server/harnesses/index.mjs'))
  const ids = mod.HARNESSES.map((h) => h.id)
  assert.deepEqual(ids, ['compass'], `registry is ${JSON.stringify(ids)} — expected exactly ["compass"]`)
})

test('never-touch files are unchanged vs upstream', () => {
  const diff = sh(`git diff --stat ${forkBase()} -- server/scan.mjs server/api.mjs server/harnesses/claude-code.mjs`)
  assert.equal(diff, '', `never-touch files differ from upstream:\n${diff}`)
})

// M2b B5 — the allowed query is POST /v1/data_sources/<id>/query for an id in compass/notion-sources.mjs and nothing else.
test('the Notion client queries only allowed data sources: a listed id goes out as the query, a refused id never builds a request', async () => {
  const { createNotion } = await import(path.join(root, 'server/harnesses/compass/notion.mjs'))
  const sources = await import(path.join(root, 'server/harnesses/compass/notion-sources.mjs'))
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' })
    return { ok: true, status: 200, json: async () => ({ results: [{ id: 'row' }], has_more: false }) }
  }
  const env = { NOTION_DS_CONTENT: '11111111222233334444555555555555' }
  const notion = createNotion({ notionToken: 't' }, { fetchImpl, env })
  assert.deepEqual((await notion.query(sources.PROJECTS, { page_size: 1 })).map((r) => r.id), ['row'])
  await notion.query(sources.DECISIONS)
  await notion.query(env.NOTION_DS_CONTENT) // an env-named source is allowed once the name is set
  assert.deepEqual(calls.map((c) => c.method), ['POST', 'POST', 'POST'])
  assert.ok(calls.every((c) => /\/v1\/data_sources\/[0-9a-f-]+\/query$/.test(c.url)), 'every POST is a data-source query')
  await assert.rejects(() => notion.query('deadbeefdeadbeefdeadbeefdeadbeef'), /not one the adapter may query/)
  await assert.rejects(() => notion.query(''), /not one the adapter may query/)
  assert.equal(calls.length, 3, 'a refused id never reaches fetch')
  // a GET carries no body and no method
  await notion.get('pages/x')
  assert.equal(calls.at(-1).method, 'GET')
  // env names: a missing name is undefined, reported by name only
  assert.equal(sources.envSources({}).RESEARCH, undefined)
  assert.deepEqual(sources.missingEnvNames({ NOTION_DS_CONTENT: env.NOTION_DS_CONTENT }).length, 6, 'the six pack names plus NOTION_DS_TASKS, minus the one set')
  assert.ok(!Object.values(sources.ENV_NAMES).includes('NOTION_DS_SENT_DOCUMENTS'), 'Sent Documents is not a source of its own (Deliverables at Status "Sent to Client")')
  assert.equal(sources.isAllowed('22222222333344445555666666666666', { NOTION_DS_TASKS: '22222222333344445555666666666666' }), true, 'the Tasks source is allowed once NOTION_DS_TASKS is set')
  assert.equal(sources.isAllowed('22222222333344445555666666666666', {}), false, 'and refused while it is not')
  assert.match(sources.unreadableNote('TASKS', new Error('notion 404: object_not_found')), /^SKIPPED:ENV — NOTION_DS_TASKS is set but unreadable: notion 404/)
  assert.equal(sources.isAllowed('33dc0af9c97480e99d5d000ba4bd72ea', {}), true, 'dashed and undashed forms are the same id')
})

test('the rules say what is true of tokens: the fork calls no model, and the PA spends Worker tokens (review 12)', () => {
  const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
  assert.ok(!/The world burns zero tokens;/.test(claude), 'CLAUDE.md no longer claims the world burns zero tokens')
  assert.match(claude, /The fork calls no model/)
  assert.match(claude, /The PA spends tokens, but on the Worker/)
})
