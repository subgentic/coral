#!/usr/bin/env bash
#
# The resource queue's shell hook (#13645), end to end on a real, isolated Coral with real agent sessions (the stand-in
# CLI, cmd/mock-agent, in ready mode: it runs the REAL PreToolUse and PostToolUse hooks of its settings for a Bash call
# typed into it as "MOCK_BASH wait|nowait <command>", and really runs the command as its child). Checks:
#   claim      a command that matches the resource's patterns claims its slot for the agent that ran it
#   refuse     the second agent's matching command is held (the hook's own deny, never run) with its place in line and how to wait
#   no command the held message, the queue's note and the server log carry the pattern, never the command
#   release    the slot goes back when the call ends, and the second agent's retry then runs
#   background a call that returns while its work (a child of the agent) still runs keeps the slot until the work is gone
#   other      a command that matches nothing is not held and claims nothing
#   by hand    a coral-board claim in a call goes back when the call ends; made by a background job's shell it stays while that shell runs (#13718)
# Usage:  tests/stress/run_resource_hook.sh      CORAL_RESOURCE_HOOK_PORT (default 8477), KEEP_TEST_DATA=1
# Never touches ~/.coral or ports 8420/8450; the server runs with --cloud-url off and is stopped by PID, its tmux by its own socket.
#
set -euo pipefail
export CORAL_TELEMETRY_DISABLED=1
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/agent_env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/backend.sh"
NP() { coral_test_native_path "$1"; }
EXE="$CORAL_TEST_EXE"
if coral_test_is_windows; then echo "SKIP: the process tree check needs ps (not on Windows)"; exit 0; fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORAL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/coral-go"
PORT="${CORAL_RESOURCE_HOOK_PORT:-8477}"
if [[ "$PORT" == 8420 || "$PORT" == 8450 ]]; then echo "ERROR: refusing port $PORT (a live Coral server's port); pick another port." >&2; exit 2; fi
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0; SERVER_PID=""
TMP="$(mktemp -d /tmp/crh.XXXXXX)"
export TMPDIR="$TMP"
DATA="$TMP/d"; BIN="$TMP/bin"
mkdir -p "$DATA" "$BIN" "$TMP/h" "$TMP/w"
log()  { echo "[resource-hook] $*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
    for sock in "$DATA"/tmux.sock "$DATA"/*.sock; do [[ -S "$sock" ]] && tmux -S "$sock" kill-server 2>/dev/null || true; done
    local pid
    for pid in $(ps -eo pid=,args= | awk -v b="$BIN/mock-agent" '$2 == b {print $1}'); do kill "$pid" 2>/dev/null || true; done
    if [[ $code -ne 0 || $FAIL -gt 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then log "Test data and server log kept: $TMP"; else rm -rf "$TMP" 2>/dev/null || { sleep 2; rm -rf "$TMP" 2>/dev/null || true; }; fi
    coral_test_sandbox_cleanup
    exit "$code"
}
trap cleanup EXIT
api() { local m="$1" p="$2"; shift 2; curl -s -m 15 -X "$m" "$BASE$p" -H "Content-Type: application/json" "$@"; }
wait_until() { local limit=$1 what=$2; shift 2; local end=$((SECONDS + limit)); while ! "$@"; do if (( SECONDS >= end )); then fail "timed out waiting for $what"; return 1; fi; sleep 0.5; done; }
# The Operator: the signed command line, outside any agent (an agent's token is never this one).
operator() { env -i PATH="$PATH" HOME="$TMP/h" CORAL_URL="$BASE" CORAL_DATA_DIR="$DATA" CORAL_DIR="$DATA" "$BIN/coral-board" "$@"; }

log "Building coral, its hooks and the stand-in agent..."
(cd "$CORAL_DIR" && go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync \
    && go build -o "$BIN/mock-agent$EXE" ./cmd/mock-agent/) 2>&1 | grep -v "ld: warning" || true
coral_test_sandbox
log "Starting an isolated server on $PORT (data $DATA)..."
env -u CORAL_CLOUD_URL -u CLAUDE_PROJECTS_DIR HOME="$TMP/h" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TMUX_NO_FALLBACK=1 MOCK_AGENT_CORAL_BOARD="$BIN/coral-board" \
    "$BIN/coral" --home "$DATA" --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" --strict-local-auth=false >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
wait_until 30 "the server" curl -fsS -m 2 "$BASE/api/health" -o /dev/null || exit 1
# the stand-in in ready mode: a real agent that runs hooks and takes typed commands
printf '#!/bin/sh\nMOCK_AGENT_READY=1 exec "%s" "$@"\n' "$BIN/mock-agent" > "$TMP/claude"; chmod 755 "$TMP/claude"
api PUT /api/settings -d "{\"cli_path_claude\": \"$TMP/claude\"}" >/dev/null

# ── the resource and two agents ───────────────────────────────────────
operator resource define mac-heavy --slots 1 --machine test --lease 60s --match "sleep 7" --match "sleep 40" >/dev/null && pass "the Operator defined mac-heavy with two matches" || fail "define"
out=$(api POST /api/sessions/launch-team -d "{\"board_name\":\"hook-team\",\"working_dir\":\"$TMP/w\",\"agents\":[
    {\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Lead.\"},{\"agent_type\":\"claude\",\"name\":\"Ann\",\"prompt\":\"Dev.\"},{\"agent_type\":\"claude\",\"name\":\"Bob\",\"prompt\":\"Dev.\"}]}")
echo "$out" | grep -q '"session' || { fail "team launch: $out"; exit 1; }
sid_of() { api GET /api/sessions/live | python3 -c '
import sys,json
d=json.load(sys.stdin); d=d.get("sessions",d) if isinstance(d,dict) else d
for s in d:
    if s.get("name","").startswith(sys.argv[1]) or s.get("agent_name")==sys.argv[1] or s.get("display_name")==sys.argv[1]: print(s["name"], s["session_id"]); break' "$1"; }
ANN=""; BOB=""
agents_up() { ANN=$(sid_of Ann); BOB=$(sid_of Bob); [[ -n "$ANN" && -n "$BOB" ]]; }
wait_until 90 "Ann and Bob to start" agents_up || exit 1
ann_name=${ANN% *}; ann_sid=${ANN#* }; bob_name=${BOB% *}; bob_sid=${BOB#* }
send() { api POST "/api/sessions/live/$1/send" -d "{\"command\":\"$3\",\"agent_type\":\"claude\",\"session_id\":\"$2\"}" >/dev/null; }
capture() { api GET "/api/sessions/live/$1/capture?agent_type=claude&session_id=$2" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("capture", d.get("output","")) if isinstance(d,dict) else d)'; }
ready() { capture "$1" "$2" | grep -q "raw input ready"; }
wait_until 60 "Ann's stand-in" ready "$ann_name" "$ann_sid" || true
wait_until 60 "Bob's stand-in" ready "$bob_name" "$bob_sid" || true
holders() { operator resource status mac-heavy | sed -n 's/^  holds   #[0-9]* \([^:( ]*\).*/\1/p' | tr '\n' ' '; }
in_line() { operator resource status mac-heavy | sed -n 's/^ *[0-9]*\.  *#[0-9]* \([^:( ]*\).*/\1/p' | tr '\n' ' '; }
holder_is() { [[ "$(holders)" == *"$1"* ]]; }
holder_is_pool() { operator resource status ph | grep -q "holds .*#[0-9]* $1\b"; } # who holds a slot of the pool ph
nobody() { [[ -z "$(holders | tr -d ' ')" ]]; }
captured() { capture "$1" "$2" | grep -q "$3"; }

if [[ -z "${ONLY_HAND:-}" ]]; then # ONLY_HAND=1: just the by-hand scenarios (a quicker run while working on them)
# ── claim, refuse, release ────────────────────────────────────────────
send "$ann_name" "$ann_sid" "MOCK_BASH wait sleep 7"
wait_until 20 "Ann's call to claim the slot" holder_is Ann && pass "Ann's matching command claimed the slot while it runs" || true
send "$bob_name" "$bob_sid" "MOCK_BASH wait sleep 7"
wait_until 20 "Bob's command to be held" captured "$bob_name" "$bob_sid" "bash REFUSED" && pass "Bob's matching command was held, not run" || true
msg=$(capture "$bob_name" "$bob_sid" | tr '\n' ' ')
[[ "$msg" == *"number 1 in line"* && "$msg" == *"resource claim mac-heavy --wait"* ]] && pass "the message names his place and how to wait" || fail "the held message: ${msg:0:300}"
[[ "$(in_line)" == *Bob* ]] && pass "Bob is in line" || fail "Bob is not in line: $(in_line)"
note=$(operator resource status mac-heavy --json | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(e.get("note","") for e in d["queue"]+d["holders"]))')
[[ "$note" == *"auto: sleep 7"* && "$note" != *"MOCK_BASH"* ]] && pass "the queue shows the pattern ($note), not the command" || fail "queue notes: $note"
wait_until 40 "Ann's call to end and the slot to go to Bob" holder_is Bob && pass "when Ann's call ended the slot went to Bob" || true
send "$bob_name" "$bob_sid" "MOCK_BASH wait sleep 7"
wait_until 20 "Bob's retry to run" captured "$bob_name" "$bob_sid" "bash RUNNING" && pass "Bob's retry ran" || true
wait_until 40 "the slot to be free after Bob's call" nobody && pass "the slot went back when Bob's call ended" || true

# ── a command that matches nothing, and a call that returns while its work runs ──
send "$ann_name" "$ann_sid" "MOCK_BASH wait sleep 1"
sleep 3
nobody && pass "a command that matches nothing claimed nothing" || fail "a non-matching command took a slot: $(holders)"
send "$ann_name" "$ann_sid" "MOCK_BASH nowait sleep 40"
wait_until 20 "Ann's backgrounded call to claim" holder_is Ann || true
wait_until 20 "the call to have returned" captured "$ann_name" "$ann_sid" "bash DONE (nowait)" && pass "Ann's call returned at once while its work keeps running" || true
sleep 12
holder_is Ann && pass "the slot is still Ann's while her backgrounded work runs" || fail "the slot was freed while the work runs: holders=$(holders)"
wait_until 60 "the work to end and the slot to go back" nobody && pass "the slot went back once the work was gone" || true

fi
# ── a claim by hand follows its tool call and its shell (#13718) ──────
# foreground: Ann claims with coral-board in a call and never releases: the slot goes back when the call ends
send "$ann_name" "$ann_sid" "MOCK_BASH wait $BIN/coral-board resource claim mac-heavy --note by-hand; sleep 6"
wait_until 20 "Ann's hand claim to be granted" holder_is Ann && pass "Ann's coral-board claim held the slot while her call ran" || fail "no hand claim: holders=$(holders)"
wait_until 40 "the hand claim to go back with its call" nobody && pass "the hand claim went back when its call ended, with no release command" || fail "the hand claim stayed after its call: holders=$(holders)"
# background: the claim is made by a shell that outlives the call; the slot stays while that shell runs, then goes back
send "$ann_name" "$ann_sid" "MOCK_BASH nowait $BIN/coral-board resource claim mac-heavy --note bg-hand; sleep 30"
wait_until 20 "Ann's background hand claim" holder_is Ann || fail "no background hand claim"
wait_until 20 "the call to have returned" captured "$ann_name" "$ann_sid" "bash DONE (nowait)" || true
sleep 12
holder_is Ann && pass "the hand claim stays while the shell of her background job runs" || fail "the background hand claim was freed while its shell runs: holders=$(holders)"
wait_until 60 "the job to end and the slot to go back" nobody && pass "the hand claim went back once the job's shell was gone" || fail "the background hand claim stayed: holders=$(holders)"

# ── a pool (#13751): a match on the pool claims it; a grant on the other machine is not run here and the agent is told how ──
operator resource define pm --slots 1 --machine Mac >/dev/null && operator resource define pmini --slots 1 --machine Mini >/dev/null && operator resource define ph --pool pm,pmini --match "sleep 11" >/dev/null && pass "a pool with a match is defined (ph = pm + pmini)" || fail "pool define"
send "$ann_name" "$ann_sid" "MOCK_BASH wait sleep 11"
wait_until 20 "Ann's pooled command to claim the Mac member" holder_is_pool Ann pm && pass "Ann's matching command claimed the pool's first free slot (the Mac)" || fail "pool claim: $(operator resource status ph)"
send "$bob_name" "$bob_sid" "MOCK_BASH wait sleep 11"
wait_until 20 "Bob's command to be redirected" captured "$bob_name" "$bob_sid" "bash REFUSED" && pass "Bob's command was not run here" || fail "no refusal for Bob"
msg=$(capture "$bob_name" "$bob_sid" | tr '\n' ' ')
[[ "$msg" == *"coral-board heavy run --"* && "$msg" == *"Mini"* ]] && pass "Bob is told to run it with coral-board heavy run, on the Mini" || fail "the redirect message: ${msg:0:300}"
[[ "$msg" != *"sleep 11"* ]] && pass "and the message does not repeat the command" || fail "the command is in the message"
operator resource status ph | grep -q "Bob.*Mini" && pass "Bob's slot on the Mini is kept for the follow-up" || fail "Bob holds nothing: $(operator resource status ph)"

# ── the server log: the pattern, never the command ────────────────────
if grep -q "shell hook" "$TMP/server.log" && ! grep -q "MOCK_BASH\|sleep 7 \|sleep 40 " "$TMP/server.log"; then pass "the server log names the resource and the pattern, not the command ($(grep -c 'shell hook' "$TMP/server.log") lines)"; else fail "the server log: $(grep -n 'shell hook\|MOCK_BASH' "$TMP/server.log" | head -3)"; fi

log "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
