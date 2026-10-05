#!/usr/bin/env bash
# Agent World — Claude Code hooks → Compass Run Ledger (Harness Step 7, Component 7).
# One session = one run: run_id = the Claude Code session_id (SKILL_RUN_LEDGER.endpoint.claude_code).
# Usage (from .claude/settings.json):
#   ledger.sh session_start   SessionStart        — writes .claude/state/<session>.session (session_id, cwd, started_at)
#                                                   and reconciles stale sessions. Posts NOTHING: the desktop app opens
#                                                   sub-second helper sessions that fire SessionStart with no prompt ever
#                                                   typed (a6e2f7d1, d16558a3, 4b23b538 on 2026-09-07 were such phantoms).
#   ledger.sh run_started     UserPromptSubmit    — run_started (id = session id) on the FIRST prompt only; the state file's
#                                                   run_started_at marker makes every later prompt a no-op.
#   ledger.sh gate_waiting    PermissionRequest   — gate_waiting, gate id appended to .claude/state/<session>.gates
#   ledger.sh gate_passed     PostToolUse + PostToolUseFailure — closes the matching gate (tool_failed on failure)
#   ledger.sh run_completed   SessionEnd          — with the marker: rejects gates still open and posts run_completed — the
#                                                   closes and the end in ONE POST {"events":[…]}, curl -m 2 (less when the sum
#                                                   ran long), so SessionEnd stays well inside its 10 s — then removes the files.
#                                                   Without it (a helper session): removes the files, posts nothing.
#                                                   U35 (ES-4.13): the payload carries usage summed from the session transcript
#                                                   (hook input transcript_path; on the reconcile path ~/.claude/projects/<slug>/
#                                                   <session_id>.jsonl) and its subagents' transcripts by .claude/hooks/usage.mjs,
#                                                   the template's count ported. No transcript → no usage key. A sum past its
#                                                   deadline (HOOK_USAGE_DEADLINE_MS, 6 s, at most 8 s) is dropped: run_completed
#                                                   goes without usage and says usage_skipped "timeout".
#   ledger.sh usage <path>    (tests, the ledger row) — prints that usage object for a transcript, or nothing.
# Reads the hook's JSON input on stdin. Never blocks the session: every failure exits 0 quietly. Needs jq and shasum;
# the usage count needs node (without it, no usage key). LEDGER_SKIP_DOTENV=1 (tests only) does not read .env.
# HOOK_DRY_RUN=1 prints each would-be POST body on stdout instead of sending it (never prints the token).
# Privacy: references only — no tool input, no command text, no file contents, no prompt text (Compass rule 6; the
# Worker refuses content-shaped keys anyway). The gate id carries a sha1 prefix of the tool input, never the input.
#
# Gate ids. PermissionRequest carries no tool_use_id (hooks reference, "PermissionRequest input"), so the gate
# is permission:<tool_name>:<12 hex of sha1(canonical tool_input JSON)>, suffixed -N when the same key is
# already open in this session. PostToolUse / PostToolUseFailure carry the same tool_input (and a tool_use_id,
# honoured when the open side had one), so the close derives the same key and pairs by it.
#
# Event ids are uuid v5 of run_id + gate + event_type: a double post (SessionEnd and a later reconcile, a
# resumed session's first prompt) is a duplicate the Worker ignores (on_conflict=id, ignore-duplicates).
set -u
EVENT="${1:-}"
# now_ms → milliseconds since the epoch: bash 5's EPOCHREALTIME, else perl (macOS and CI images have it), else whole
# seconds. SessionEnd's budget is wall-clock from the hook's own start, so it holds on a loaded machine too.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then local t="${EPOCHREALTIME/[.,]/}"; echo $(( t / 1000 )); return; fi
  perl -MTime::HiRes=time -e 'printf "%d\n", time*1000' 2>/dev/null || echo $(( $(date +%s) * 1000 ))
}
case "$EVENT" in run_completed) HOOK_T0="$(now_ms)" ;; esac   # before anything else: the budget counts from here
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
# usage_result <transcript path> [until, ms since the epoch] → one line {"usage": {…}|null, "skipped": "timeout"|null, "elapsed_ms": n} from
# .claude/hooks/usage.mjs (the template's count, ported: the session transcript and <session>/subagents/*.jsonl, one
# de-duplication across all of them, the cache split, by_model, subagents — see that file), or nothing: no path, no
# node, or no answer. usage.mjs keeps its own deadline and ends itself after a timeout; this waits at most 9 s more
# for it as a last resort (a node that cannot even start), so SessionEnd always reaches its post.
usage_result() {
  [ -n "${1:-}" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local tmp pid timer
  tmp="$(mktemp "${TMPDIR:-/tmp}/aw-usage.XXXXXX")" || return 0
  node "$HERE/.claude/hooks/usage.mjs" "$1" ${2:+--until "$2"} </dev/null >"$tmp" 2>/dev/null &
  pid=$!
  ( sleep 9; kill -KILL "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
  timer=$!
  { wait "$pid"; } 2>/dev/null
  kill "$timer" 2>/dev/null; { wait "$timer"; } 2>/dev/null
  head -n 1 "$tmp" | jq -ce 'select(type == "object")' 2>/dev/null
  rm -f "$tmp"
  return 0
}
# usage_json <transcript path> → just the usage object, or nothing (the row's tokens; `ledger.sh usage`).
usage_json() {
  local r
  r="$(usage_result "${1:-}")"
  [ -n "$r" ] || return 0
  if [ "$(printf '%s' "$r" | jq -r '.skipped // empty')" = "timeout" ]; then echo "usage skipped: timeout (HOOK_USAGE_DEADLINE_MS)" >&2; return 0; fi
  printf '%s' "$r" | jq -c '.usage // empty'
}
if [ "$EVENT" = "usage" ]; then usage_json "${2:-}"; exit 0; fi
[ -z "${LEDGER_SKIP_DOTENV:-}" ] && [ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a
: "${EVENTS_URL:=https://tellefsen-compass-mcp.christoffer-7e3.workers.dev/events}"
DRY_RUN="${HOOK_DRY_RUN:-${LEDGER_DRY_RUN:-}}"
[ -n "${EVENTS_BEARER_TOKEN:-}" ] || [ -n "$DRY_RUN" ] || exit 0   # no token, no ledger — the session still runs
command -v jq >/dev/null 2>&1 || exit 0              # jq is required; install with brew install jq
command -v shasum >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
SESSION="$(printf '%s' "$INPUT" | jq -r '.session_id // empty')"
[ -n "$SESSION" ] || exit 0
HOOK_EVENT="$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty')"
TOOL="$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')"
TOOL_USE_ID="$(printf '%s' "$INPUT" | jq -r '.tool_use_id // empty')"
INPUT_HASH="$(printf '%s' "$INPUT" | jq -cS '.tool_input // {}' | shasum | cut -c1-12)"
CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty')"
PROJECT="${AGENT_WORLD_PROJECT_ID:-3d1c0af9-c974-81ce-8a25-f4bdeadd54ab}"
REPO_URL="${REPO_URL:-https://github.com/Christoffer-Tellefsen/agent-world}"
STATE_DIR="${LEDGER_STATE_DIR:-$HERE/.claude/state}"          # tests point this at a scratch dir
GATES="$STATE_DIR/$SESSION.gates"
STATE="$STATE_DIR/$SESSION.session"
RUN_ID_FILE="${LEDGER_RUN_ID_FILE:-$HERE/.claude/run_id}"
PROJECTS_DIR="${LEDGER_PROJECTS_DIR:-$HOME/.claude/projects}"  # where Claude Code keeps <slug>/<session_id>.jsonl
STALE_MINUTES="${LEDGER_STALE_MINUTES:-30}"
mkdir -p "$STATE_DIR"

post() {  # $1 = JSON body, $2 = curl's --max-time (default 4 s). Dry run prints the body instead (never the token).
  if [ -n "$DRY_RUN" ]; then printf '%s\n' "$1"; return 0; fi
  curl -s -m "${2:-4}" -o /dev/null -X POST "$EVENTS_URL" \
    -H "Authorization: Bearer $EVENTS_BEARER_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$1" || true
}
uuid5() {  # $1 = name → RFC 4122 v5 uuid in the URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8)
  local h v
  h="$( { printf '\x6b\xa7\xb8\x11\x9d\xad\x11\xd1\x80\xb4\x00\xc0\x4f\xd4\x30\xc8'; printf '%s' "$1"; } | shasum | cut -c1-32)"
  case "${h:16:1}" in [0-3]) v=8 ;; [4-7]) v=9 ;; [89ab]) v=a ;; *) v=b ;; esac
  printf '%s-%s-5%s-%s%s-%s' "${h:0:8}" "${h:8:4}" "${h:13:3}" "$v" "${h:17:3}" "${h:20:12}"
}
eid() {  # $1 = run_id, $2 = gate (may be empty), $3 = event_type
  uuid5 "agent-world:$1:$2:$3"
}
base() {  # $1 = run_id, $2 = event_type, $3 = payload json, $4 = id
  jq -cn --arg t "$2" --arg run "$1" --arg project "$PROJECT" --arg id "$4" --argjson payload "$3" '
    {id:$id, event_type:$t, run_id:$run, skill:"agent-world-build", trigger:"claude_code", client:null,
     project:$project, actor:"claude_code", payload:$payload}'
}
gate_payload() {  # $1 = gate, $2 = extra json object merged in
  jq -cn --arg g "$1" --arg u "$REPO_URL" --argjson x "$2" '{gate:$g,surface:"class_b_gate",ref_url:$u} + $x'
}
open_gates() {  # $1 = gates file → lines "key<TAB>gate", oldest first, for gates opened and not yet closed
  [ -f "$1" ] || return 0
  awk -F'\t' '$1=="open"{o[$3]=$2; ord[++n]=$3} $1=="close"{delete o[$2]}
              END{for(i=1;i<=n;i++) if (ord[i] in o) print o[ord[i]] "\t" ord[i]}' "$1"
}
# The session state file. started() says whether run_started was posted for a session:
# "yes" when its state file carries the marker, "legacy" when only a pre-marker .gates file exists (the old hooks
# posted run_started at SessionStart, so that run still owes a run_completed), "no" otherwise.
write_state() {  # $1 = session id, $2 = cwd
  [ -f "$STATE_DIR/$1.session" ] && return 0                 # resume / compact fire SessionStart again: keep the marker
  jq -cn --arg s "$1" --arg c "$2" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{session_id:$s, cwd:$c, started_at:$t, run_started_at:null}' > "$STATE_DIR/$1.session"
}
started() {  # $1 = session id
  local f="$STATE_DIR/$1.session"
  if [ -f "$f" ]; then
    [ "$(jq -r '.run_started_at // empty' "$f" 2>/dev/null)" != "" ] && echo yes || echo no
  elif [ -f "$STATE_DIR/$1.gates" ]; then echo legacy
  else echo no; fi
}
# close_run: the open gates' closes (rejected) and run_completed in ONE POST {"events":[…]} (review item 3, 2026-10-05):
# one round trip, so a Worker that never answers costs the hook one --max-time, not one per gate. The Worker takes at
# most 50 events a request, so at most 49 closes ride with the end (a session never has that many prompts open at once).
close_run() {  # $1 = run_id, $2 = gates file, $3 = note for the rejected closes, $4 = run_completed payload, $5 = the budget's end (ms)
  local key gate extra events n=0
  extra="$(jq -cn --arg n "$3" '{result:"rejected",note:$n}')"
  events=""
  while IFS=$'\t' read -r key gate; do
    [ -n "$gate" ] || continue
    [ "$n" -lt 49 ] || break
    n=$((n + 1))
    printf 'close\t%s\n' "$gate" >> "$2"
    events="$events$(base "$1" gate_passed "$(gate_payload "$gate" "$extra")" "$(eid "$1" "$gate" gate_passed)")"$'\n'
  done < <(open_gates "$2")
  events="$events$(base "$1" run_completed "$4" "$(eid "$1" "" run_completed)")"
  events="$(printf '%s\n' "$events" | jq -cs '{events: .}')"
  post "$events" "$(post_max $(( ${5:-0} - $(now_ms) )))"
  rm -f "$2"
}
# with_usage <payload json> <usage_result line> → the payload plus {usage} when the transcripts sum to something (U35),
# or {usage_skipped: "timeout"} when the sum ran past its deadline — the run still ends, without a count.
with_usage() {
  jq -cn --argjson p "$1" --argjson r "${2:-null}" '$p + (if ($r | type) != "object" then {} elif $r.usage then {usage: $r.usage} elif $r.skipped then {usage_skipped: $r.skipped} else {} end)'
}
# SessionEnd's budget: 9 s of the hook's 10 s, wall-clock from the hook's start (LEDGER_POST_BUDGET_MS, tests only, may
# only lower it). The sum may run until 1 s before its end (usage.mjs --until; never past its own 6 s / 8 s deadline),
# and the POST gets what is left when it goes: 2 s at most, never under 0.5 s.
post_budget_ms() {
  case "${LEDGER_POST_BUDGET_MS:-}" in ''|*[!0-9]*) echo 9000 ;; *) [ "$LEDGER_POST_BUDGET_MS" -lt 9000 ] && echo "$LEDGER_POST_BUDGET_MS" || echo 9000 ;; esac
}
# post_max <ms left> → curl's --max-time in seconds: 2 at most, 0.5 at least.
post_max() {
  local r="${1:-0}"
  case "$r" in -*|''|*[!0-9-]*) r=0 ;; esac
  if [ "$r" -ge 2000 ]; then echo 2; elif [ "$r" -le 500 ]; then echo 0.5; else printf '%d.%03d\n' $(( r / 1000 )) $(( r % 1000 )); fi
}
# transcript_for <session id> → the path Claude Code writes the session's transcript to: <projects>/<slug of cwd>/<id>.jsonl,
# the slug being the cwd with every character outside [A-Za-z0-9] as "-" (the state file carries the cwd; else this repo).
transcript_for() {
  local cwd slug
  cwd="$( [ -f "$STATE_DIR/$1.session" ] && jq -r '.cwd // empty' "$STATE_DIR/$1.session" 2>/dev/null )"
  [ -n "$cwd" ] || cwd="$HERE"
  slug="$(printf '%s' "$cwd" | sed 's/[^A-Za-z0-9]/-/g')"
  printf '%s/%s/%s.jsonl' "$PROJECTS_DIR" "$slug" "$1"
}
end_session() {  # $1 = session id, $2 = note for rejected closes, $3 = run_completed payload, $4 = transcript path. Posts only if run_started was.
  local r end
  case "$(started "$1")" in
    yes|legacy)
      # the budget runs from the hook's start at SessionEnd; a reconcile at SessionStart gives each closed session its own
      end=$(( ${HOOK_T0:-$(now_ms)} + $(post_budget_ms) ))
      r="$(usage_result "${4:-}" $(( end - 1000 )))"
      close_run "$1" "$STATE_DIR/$1.gates" "$2" "$(with_usage "$3" "$r")" "$end" ;;
    *) rm -f "$STATE_DIR/$1.gates" ;;
  esac
  rm -f "$STATE_DIR/$1.session"
}

case "$EVENT" in
  session_start)
    write_state "$SESSION" "$CWD"
    rm -f "$HERE/.claude/.gate-open"                      # pre-follow-up marker, no longer used
    # Reconcile: SessionEnd may never fire when the desktop app closes a session. Another session's files untouched
    # for STALE_MINUTES (every prompt and tool use touches them) are a session that ended without its SessionEnd:
    # a run that posted run_started gets its terminal event; a helper session that never did is just cleaned up.
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      sid="$(basename "$f")"; sid="${sid%.*}"
      [ "$sid" != "$SESSION" ] || continue
      [ -f "$STATE_DIR/$sid.session" ] && [ "${f##*.}" = "gates" ] && continue   # judged by its .session file instead
      # U35: the closed session's transcript is still on disk — its usage rides on the reconciled run_completed
      end_session "$sid" "unresolved_at_session_end" '{"outcome":"success","note":"reconciled_at_next_session_start"}' "$(transcript_for "$sid")"
    done < <(find "$STATE_DIR" -maxdepth 1 \( -name '*.session' -o -name '*.gates' \) -mmin "+$STALE_MINUTES" 2>/dev/null)
    ;;
  run_started)
    # UserPromptSubmit: the first prompt of a session is what makes it a run. Once per session, marker in the state file.
    write_state "$SESSION" "$CWD"                         # the hook may have been added mid-session
    [ "$(started "$SESSION")" = "yes" ] && { touch "$STATE" "$GATES" 2>/dev/null; exit 0; }
    tmp="$(jq -c --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.run_started_at=$t' "$STATE")" && printf '%s\n' "$tmp" > "$STATE"
    printf '%s' "$SESSION" > "$RUN_ID_FILE"
    [ -f "$GATES" ] || : > "$GATES"
    post "$(base "$SESSION" run_started '{"run_class":"B_judge","skill_version":"m1"}' "$SESSION")"
    ;;
  gate_waiting)
    # A permission prompt is a Class B gate held by a human (SKILL_RUN_LEDGER.write_protocol.1_gates).
    KEY="${TOOL_USE_ID:-h:$INPUT_HASH}"
    GATE="permission:${TOOL:-tool}:${TOOL_USE_ID:-$INPUT_HASH}"
    # Suffix repeats of the same key (open or already closed) so gate ids — and their event ids — stay unique.
    N="$( { [ -f "$GATES" ] && cat "$GATES"; } | awk -F'\t' -v k="$KEY" '$1=="open"&&$2==k{n++} END{print n+0}')"
    [ "$N" -eq 0 ] || GATE="$GATE-$((N+1))"
    printf 'open\t%s\t%s\n' "$KEY" "$GATE" >> "$GATES"
    [ -f "$STATE" ] && touch "$STATE"
    post "$(base "$SESSION" gate_waiting "$(gate_payload "$GATE" '{}')" "$(eid "$SESSION" "$GATE" gate_waiting)")"
    ;;
  gate_passed)
    # Fires after every tool (PostToolUse and PostToolUseFailure); only meaningful when this call held a prompt.
    [ -f "$GATES" ] && touch "$GATES"                    # activity heartbeat for the reconcile age check
    [ -f "$STATE" ] && touch "$STATE"
    GATE="$(open_gates "$GATES" | awk -F'\t' -v a="${TOOL_USE_ID:-}" -v b="h:$INPUT_HASH" '($1==b)||(a!=""&&$1==a){print $2; exit}')"
    [ -n "$GATE" ] || exit 0
    printf 'close\t%s\n' "$GATE" >> "$GATES"
    EXTRA='{"result":"approved"}'
    [ "$HOOK_EVENT" != "PostToolUseFailure" ] || EXTRA='{"result":"approved","tool_failed":true}'
    post "$(base "$SESSION" gate_passed "$(gate_payload "$GATE" "$EXTRA")" "$(eid "$SESSION" "$GATE" gate_passed)")"
    ;;
  run_completed)
    # SessionEnd (per-hook timeout 10 s in settings.json). A prompt still open at exit was never answered: close it
    # as rejected so no ? outlives the session, then the terminal event — but only for a session that posted
    # run_started. A helper session with no prompt just loses its state file. Not on Stop — Stop is per turn.
    # U35: usage from the transcript the hook input names (falls back to the projects dir path); missing → no usage key, still exit 0.
    TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')"
    [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || TRANSCRIPT="$(transcript_for "$SESSION")"
    end_session "$SESSION" "unresolved_at_session_end" '{"outcome":"success"}' "$TRANSCRIPT"
    # The ops_skill_runs row is written by the session itself at end-of-run (CLAUDE.md, session rule 6) — tokens_in =
    # usage.input + cache_creation + cache_read, tokens_out = usage.output_tokens, model = usage.model when usage was posted.
    ;;
  *) exit 0 ;;
esac
exit 0
