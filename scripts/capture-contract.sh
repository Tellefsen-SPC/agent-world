#!/usr/bin/env bash
# Agent World — re-capture the Worker responses the contract test validates (U34, U35, U37 — docs/CONTRACT.md).
# GET only. Bearer from .env, never printed. Actors scrubbed, notes trimmed; the ZZTEST runs plus ten others.
#   (no flag)          GET /world/substrate, GET /world/spend?window=30 and GET /ledger/scan (the last 14 days)
#   --substrate-only   GET /world/substrate alone (a Worker deploy that changed only the substrate — v2, 2026-09-07)
#   --spend-only       GET /world/spend?window=30 alone (U35W)
#   --cost-only        GET /ledger/cost?days=1&include_test=1 alone (Compass U5, U37) → test/fixtures/ledger-cost.live.json.
#                      Run it once U5 is deployed; until then the contract test validates the synthetic answer only.
#                      Town names other than ZZTEST… and "internal" are replaced by town-1, town-2 … (the repo is public).
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
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s)
  if(!Array.isArray(j.by_town)){console.error("GET /ledger/cost answered without by_town — not written");process.exit(1)}
  const names=new Map()
  const town=(t)=>/^zztest/i.test(t)||t==="internal"?t:(names.has(t)?names.get(t):(names.set(t,`town-${names.size+1}`),names.get(t)))
  const out={note:`GET /ledger/cost?days=1&include_test=1 captured ${process.argv[1]} for the contract test (U37, Compass U5). Town names other than ZZTEST and internal replaced. Re-capture with scripts/capture-contract.sh --cost-only.`,...j,by_town:j.by_town.map(r=>({...r,town:town(String(r.town))}))}
  require("fs").writeFileSync(process.argv[2],JSON.stringify(out,null,1)+"\n")
  console.log("cost captured:",j.totals?.runs_total,"runs,",j.by_town.length,"towns")
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
