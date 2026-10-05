#!/usr/bin/env bash
# Agent World — re-capture the Worker responses the contract test validates (U34, U35, U37 — docs/CONTRACT.md).
# GET only. Bearer from .env, never printed. Actors scrubbed, notes trimmed; the ZZTEST runs plus ten others.
#   (no flag)          GET /world/substrate, GET /world/spend?window=30 and GET /ledger/scan (the last 14 days)
#   --substrate-only   GET /world/substrate alone (a Worker deploy that changed only the substrate — v2, 2026-09-07)
#   --spend-only       GET /world/spend?window=30 alone (U35W)
#   --cost-only        GET /ledger/cost?days=1&include_test=1 alone (Compass U5, U37) → test/fixtures/ledger-cost.live.json.
#                      Run it once U5 is deployed; until then the contract test validates the synthetic answer only.
#                      Kept by path and shape against the contract: every town but ZZTEST… and "internal" becomes
#                      town-1, town-2 … in by_town and by_town_day alike; a value of the wrong shape at a known path is
#                      redacted and said; a key the contract has not got, at any depth, refuses the capture (nothing is
#                      written) and names the path. Values are never printed (the repo is public).
# CAPTURE_DIR overrides where the files go (default test/fixtures). CAPTURE_SKIP_DOTENV=1 leaves .env unread — the
# tests use both, with a local stand-in for the Worker; nothing here is ever pointed at the real Worker by a test.
set -euo pipefail
ONLY="${1:-}"
case "$ONLY" in
  ''|--substrate-only|--spend-only|--cost-only) ;;
  *) echo "usage: scripts/capture-contract.sh [--substrate-only | --spend-only | --cost-only]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
if [ -f .env ] && [ -z "${CAPTURE_SKIP_DOTENV:-}" ]; then set -a; . ./.env; set +a; fi
: "${EVENTS_URL:?set EVENTS_URL in .env}"; : "${EVENTS_BEARER_TOKEN:?set EVENTS_BEARER_TOKEN in .env}"
W="${EVENTS_URL%/}"; W="${W%/events}"
STAMP=$(date -u +%Y-%m-%d)
OUT="${CAPTURE_DIR:-test/fixtures}"

if [ "$ONLY" = "--cost-only" ]; then
  BODY=$(curl -sf -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" "$W/ledger/cost?days=1&include_test=1") \
    || { echo "GET /ledger/cost did not answer 200 — is Compass U5 deployed? Nothing written." >&2; exit 1; }
  printf '%s' "$BODY" | node -e '
// By path and shape, not by key name: the answer is walked against the contract (spec/ledger-cost.v1.json), and a value
// is kept only at its known path and in its expected shape. at / since: ISO times. by_town_day[].day: YYYY-MM-DD.
// town_source: town | client. pricing_version: the version and its date, the free text after them dropped. The counters:
// numbers. A town (by_town[].town, by_town_day[].town): town-n, the same stand-in in both lists; ZZTEST… and internal
// kept. A value of the wrong shape at a known path is redacted and said. A key the contract has not got, at any depth,
// is redacted with everything under it, and the file is not written at all: the answer has changed, and a person
// decides. Paths are printed, values never.
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const N="number"
const COUNTERS={runs_total:N,runs_metered:N,runs_unmetered:N,runs_unpriced:N,tokens_in:N,tokens_out:N,tokens_unpriced:N,cost_usd:N,methods:{breakdown:N,flat:N}}
const SHAPE={at:"iso",days:N,since:"iso",pricing_version:"version",town_source:"source",excluded_test_runs:N,totals:COUNTERS,by_town:[{town:"town",...COUNTERS}],by_town_day:[{day:"day",town:"town",...COUNTERS}]}
const names=new Map();const unknown=[];const redacted=[];const trimmed=[]
const town=(s)=>{if(/^zztest/i.test(s)||s==="internal")return s;if(!names.has(s))names.set(s,`town-${names.size+1}`);return names.get(s)}
const plain=(v)=>v!==null&&typeof v==="object"&&!Array.isArray(v)
const redact=(path)=>(redacted.push(path),"redacted")
function walk(v,shape,path){
  if(Array.isArray(shape))return Array.isArray(v)?v.map((x,i)=>walk(x,shape[0],`${path}[${i}]`)):redact(path)
  if(plain(shape)){
    if(!plain(v))return redact(path)
    const out={};let n=0
    for(const [k,x] of Object.entries(v)){
      if(Object.hasOwn(shape,k))out[k]=walk(x,shape[k],`${path}.${k}`)
      else{unknown.push(`${path}.${k}`);out[`unknown-${++n}`]="redacted"} // the subtree is not read, the key not kept
    }
    return out
  }
  if(shape===N)return v===null||typeof v==="number"?v:redact(path)
  if(shape==="iso")return typeof v==="string"&&ISO.test(v)&&!Number.isNaN(Date.parse(v))?v:redact(path)
  if(shape==="day")return typeof v==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:redact(path)
  if(shape==="source")return v==="town"||v==="client"?v:redact(path)
  if(shape==="version"){
    if(v===null)return null
    const m=typeof v==="string"&&v.match(/^v?\d+(?:\.\d+){0,3}(?: · \d{4}-\d{2}-\d{2})?/)
    if(!m)return redact(path)
    if(m[0]!==v)trimmed.push(path)
    return m[0]
  }
  if(shape==="town")return typeof v==="string"&&v.trim()?town(v):redact(path)
  return redact(path)
}
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s)
  if(!plain(j)||!Array.isArray(j.by_town)){console.error("GET /ledger/cost answered without by_town — nothing written");process.exit(1)}
  const clean=walk(j,SHAPE,"$")
  for(const p of unknown)console.error(`unknown key at ${p} — refused, the Worker answer has changed`)
  if(unknown.length){console.error(`nothing written: teach scripts/capture-contract.sh and spec/ledger-cost.v1.json the new keys first (${unknown.length} unknown)`);process.exit(1)}
  for(const p of redacted)console.error(`redacted ${p}: not the shape the contract names`)
  for(const p of trimmed)console.error(`trimmed ${p} to its version and date`)
  const out={note:`GET /ledger/cost?days=1&include_test=1 captured ${process.argv[1]} for the contract test (U37, Compass U5). Kept by path and shape only; towns other than ZZTEST and internal replaced by town-n. Re-capture with scripts/capture-contract.sh --cost-only.`,...clean}
  require("fs").writeFileSync(process.argv[2],JSON.stringify(out,null,1)+"\n")
  console.log("cost captured:",clean.totals?.runs_total,"runs,",clean.by_town.length,"towns,",names.size,"town names replaced")
})' "$STAMP" "$OUT/ledger-cost.live.json"
  exit 0
fi

[ "$ONLY" = "--spend-only" ] || curl -sf -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" "$W/world/substrate" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);j.note=`GET /world/substrate captured ${process.argv[1]} for the contract test (U34). Re-capture with scripts/capture-contract.sh.`;require("fs").writeFileSync(process.argv[2],JSON.stringify(j,null,1)+"\n");console.log("substrate captured:",Object.keys(j).join(","))})' "$STAMP" "$OUT/m2b-substrate.live.json"
[ "$ONLY" = "--substrate-only" ] && exit 0
curl -sf -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" "$W/world/spend?window=30" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const out={note:`GET /world/spend?window=30 captured ${process.argv[1]} for the contract test (U35, ES-4.13). Re-capture with scripts/capture-contract.sh.`,...j};require("fs").writeFileSync(process.argv[2],JSON.stringify(out,null,1)+"\n");console.log("spend captured:",j.totals?.runs_total,"runs,",j.totals?.runs_metered,"metered")})' "$STAMP" "$OUT/m2b-spend.live.json"
[ "$ONLY" = "--spend-only" ] && exit 0
SINCE=$(node -e 'process.stdout.write(new Date(Date.now()-14*864e5).toISOString())')
curl -sf -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" "$W/ledger/scan?since=$SINCE" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s)
  const runIds=[...new Set(j.events.map(e=>e.run_id))]
  const zz=runIds.filter(id=>j.events.some(e=>e.run_id===id&&/^zztest-/.test(e.skill||"")))
  const keep=new Set([...zz,...runIds.filter(id=>!zz.includes(id)).slice(0,10)])
  const events=j.events.filter(e=>keep.has(e.run_id)).map(e=>({...e, actor: e.actor ? "actor" : e.actor}))
  const rows=j.rows.filter(r=>keep.has(r.id)).map(r=>({...r, notes: typeof r.notes==="string" ? r.notes.slice(0,80) : r.notes}))
  require("fs").writeFileSync(process.argv[2], JSON.stringify({captured_at:new Date().toISOString(), note:`GET /ledger/scan sample captured ${process.argv[1]} for the contract test (U34): the ZZTEST runs plus ten others; actors scrubbed, notes trimmed. Re-capture with scripts/capture-contract.sh.`, events, rows}, null, 1)+"\n")
  console.log("scan captured:", events.length, "events,", rows.length, "rows")
})' "$STAMP" "$OUT/m2b-ledger-scan.live.json"
