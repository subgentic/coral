#!/usr/bin/env bash
#
# coral-search done-when check (goal #244, #19402): one word planted in each place only (a task body, a goal's outcome, a board
# post, a stand-in agent's chat), on an isolated dev server (scratch data dir, --cloud-url off, --no-browser, telemetry off).
# From an agent's shell 'coral-board search' finds each and --source narrows to it; the dashboard's search route returns the
# same hits; the starting prompt names the command.
#
# Usage:  tests/stress/run_search_sources.sh      CORAL_SEARCH_SOURCES_PORT (default 8478), KEEP_TEST_DATA=1
# Never touches ~/.coral or ports 8420/8450.
#
set -euo pipefail
export CORAL_TELEMETRY_DISABLED=1
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/agent_env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/backend.sh"
NP() { coral_test_native_path "$1"; }
EXE="$CORAL_TEST_EXE"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORAL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/coral-go"
PORT="${CORAL_SEARCH_SOURCES_PORT:-8478}"
if [[ "$PORT" == 8420 || "$PORT" == 8450 ]]; then echo "ERROR: refusing port $PORT (a live Coral server's port); pick another port." >&2; exit 2; fi
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0; SERVER_PID=""
TMP="$(mktemp -d /tmp/css.XXXXXX)"
export TMPDIR="$TMP"
DATA="$TMP/d"; DUMP="$TMP/dump"; BIN="$TMP/bin"
mkdir -p "$DATA" "$DUMP" "$BIN" "$TMP/h" "$TMP/w"
log()  { echo "[sources] $*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
own_mock_pids() { ps -eo pid=,args= | awk -v b="$BIN/mock-agent" '$2 == b {print $1}'; }
cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
    for sock in "$DATA"/tmux.sock "$DATA"/*.sock; do [[ -S "$sock" ]] && tmux -S "$sock" kill-server 2>/dev/null || true; done
    local pid; for pid in $(own_mock_pids); do kill "$pid" 2>/dev/null || true; done
    if [[ $code -ne 0 || $FAIL -gt 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then log "Test data and server log kept: $TMP"; else rm -rf "$TMP" 2>/dev/null || { sleep 2; rm -rf "$TMP" 2>/dev/null || true; }; fi
    coral_test_sandbox_cleanup
    exit "$code"
}
trap cleanup EXIT
JAR="$TMP/jar"; COOKIE_ARGS=""
api() { local m="$1" p="$2"; shift 2; curl -s -m 20 $COOKIE_ARGS -X "$m" "$BASE$p" -H "Content-Type: application/json" "$@"; }
wait_until() { local limit=$1 what=$2; shift 2; local end=$((SECONDS + limit)); while ! "$@"; do if (( SECONDS >= end )); then fail "timed out waiting for $what"; return 1; fi; sleep 0.5; done; }
token_of() { sed -n 's/^CORAL_SESSION_TOKEN=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
sess_of() { sed -n 's/^CORAL_SESSION_NAME=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
role_of() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('job_title',''))" "$(NP "$DATA/board_state_$(sess_of "$1").json")" 2>/dev/null || true; }
live_json() { api GET /api/sessions/live | python3 -c 'import sys,json
d=json.load(sys.stdin); d=d.get("sessions",d) if isinstance(d,dict) else d
print(json.dumps(d))'; }
# '<session_id>' of the first live agent whose board LABEL is $1 and whose display name is $2
agent_of() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if str(s.get("board_label",""))==sys.argv[1] and (s.get("display_name") or "")==sys.argv[2]: print(s["session_id"]); break' "$1" "$2"; }
board_key_of() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if str(s.get("board_label",""))==sys.argv[1]: print(s["board_project"]); break' "$1"; }
# the real coral-board, from an agent's own environment: as_agent <session_id> <coral-board args...>
as_agent() {
    local sid=$1; shift
    env -i PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" \
        CORAL_SESSION_TOKEN="$(token_of "$sid")" CORAL_SESSION_NAME="$(sess_of "$sid")" CORAL_SUBSCRIBER_ID="$(role_of "$sid")" "$BIN/coral-board" "$@" 2>&1
}
operator_post() { api POST "/api/board/$1/messages" -d "$(python3 -c 'import json,sys; print(json.dumps({"subscriber_id":"Operator","content":sys.argv[1]}))' "$2")" >/dev/null; }

log "Building coral, coral-board and the stand-in agent..."
(cd "$CORAL_DIR" && go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-stop 2>/dev/null \
    || go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state) && (cd "$CORAL_DIR" && go build -o "$BIN/mock-agent$EXE" ./cmd/mock-agent/)
log "Starting an isolated STRICT server on $PORT (data $DATA)..."
coral_test_sandbox
env -u CORAL_CLOUD_URL -u CLAUDE_PROJECTS_DIR HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TMUX_NO_FALLBACK=1 MOCK_AGENT_CORAL_BOARD="$BIN/coral-board" MOCK_AGENT_TRANSCRIPT=1 MOCK_AGENT_ENV_DUMP="$(NP "$DUMP")" \
    "$BIN/coral" --home "$(NP "$DATA")" --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" --strict-local-auth >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
wait_until 30 "the server" curl -fsS -m 2 "$BASE/api/health" -o /dev/null || exit 1
signin=""
for _ in $(seq 1 30); do   # the command-line token file appears a moment after the server answers its health check
    signin=$(env -u DISPLAY "$BIN/coral" open --print --url "$BASE" --home "$(NP "$DATA")" 2>/dev/null | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1 || true)
    [[ -n "$signin" ]] && break
    sleep 1
done
[[ -n "$signin" ]] && curl -s -m 10 -c "$JAR" -o /dev/null "$signin"
grep -q coral_session "$JAR" 2>/dev/null && COOKIE_ARGS="-b $JAR" || { fail "could not sign in"; exit 1; }
api PUT /api/settings -d "{\"cli_path_claude\": \"$(NP "$BIN/mock-agent$EXE")\"}" >/dev/null

# ── Setup: one team, an Orchestrator and a Dev ─────────────────────────────────────────────────────────
# this throwaway server's owner (the dashboard sign-in above) reads the first-launch notice, as a person does before the first dialog launch
DISC=$(api GET /api/launch-disclosure | python3 -c 'import sys,json; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)
[[ -n "$DISC" ]] && api POST /api/launch-disclosure/ack -d "{\"id\":\"$DISC\"}" >/dev/null
LAUNCH=$(api POST /api/sessions/launch-team -d "{\"board_name\":\"srcchk\",\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[
    {\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Lead.\"},{\"agent_type\":\"claude\",\"name\":\"Dev\",\"prompt\":\"Dev.\"}]}")
log "launch-team: ${LAUNCH:0:300}"
wait_until 90 "the agents to start" bash -c "[[ \$(ls '$DUMP'/*.env 2>/dev/null | wc -l) -ge 2 ]]" || exit 1
sleep 3
K=$(board_key_of srcchk); SO=$(agent_of srcchk Orchestrator); SD=$(agent_of srcchk Dev)
[[ -n "$K" && -n "$SO" && -n "$SD" ]] || { fail "setup: board=$K orchestrator=$SO dev=$SD"; exit 1; }
wait_until 40 "the agents' dumps" bash -c "grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$SO.env' 2>/dev/null && grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$SD.env' 2>/dev/null" || exit 1
R="$RANDOM$RANDOM"; WT="taskonlyword$R"; WG="goalonlyword$R"; WP="postonlyword$R"; WC="chatonlyword$R"

# ── Plant one word in each place ────────────────────────────────────────────────────────────────────────
out=$(as_agent "$SO" task add "plant task" --body "details: $WT") && pass "plant: task body has $WT" || fail "plant task: ${out:0:200}"
out=$(as_agent "$SO" goal add "plant goal" --outcome "outcome: $WG" --done-when "planted" --state proposed) && pass "plant: goal outcome has $WG" || fail "plant goal: ${out:0:200}"
operator_post "$K" "post: $WP"; pass "plant: board post has $WP"
# A person's message cannot be typed into the stand-in (it draws no input box: the send is refused agent_not_ready), so the chat word
# is appended to Dev's own transcript file as a user turn, the file the history index reads.
# the file appears once Dev has its first nudge (the board post above)
wait_until 40 "Dev's transcript file" bash -c "ls '$TMP'/h/.claude/projects/*/'${SD#claude-}'.jsonl >/dev/null 2>&1" || true
TF=$(ls "$TMP"/h/.claude/projects/*/"${SD#claude-}".jsonl 2>/dev/null | head -1)
[[ -n "$TF" ]] || { fail "setup: no transcript for Dev ($SD)"; exit 1; }
python3 - "$TF" "$SD" "$WC" <<'PY'
import json,sys,datetime
f,sid,w=sys.argv[1:4]; sid=sid.replace("claude-","",1)
first=json.loads(open(f).readline())
first.update(sessionId=sid,uuid="chat-"+w,parentUuid=None,timestamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
first["message"]={"role":"user","content":"chat: "+w}
open(f,"a").write(json.dumps(first)+"\n")
PY
log "chat word appended to $TF"
wait_until 30 "the stand-in agent's transcript to hold the chat word" bash -c "grep -rqs '$WC' '$TMP/h/.claude/projects'" || log "transcripts: $(find "$TMP/h/.claude/projects" -name '*.jsonl' 2>/dev/null | tr '\n' ' ')"
sleep 3   # the history index reads the new line

# ── From the agent's shell: found, and --source narrows to it ───────────────────────────────────────────
hit() { [[ "$1" == *"$2"* && "$1" != "No messages, tasks, goals or past chats match"* ]]; } # a result list that carries the word (not the "No ... match" line, which repeats it)
check() { # <word> <source> <what>
    local w=$1 src=$2 what=$3 out
    out=$(as_agent "$SD" search "$w") || true
    echo "$out" > "$TMP/found_$src.out"
    hit "$out" "$w" && pass "found: '$w' (only in $what) is found by 'coral-board search'" || fail "found: '$w' ($what): ${out:0:300}"
    out=$(as_agent "$SD" search "$w" --source "$src") || true
    hit "$out" "$w" && pass "narrow: --source $src finds '$w'" || fail "narrow: --source $src '$w': ${out:0:300}"
    local other bad=""
    for other in messages tasks goals history; do
        [[ $other == "$src" ]] && continue
        out=$(as_agent "$SD" search "$w" --source "$other") || true
        hit "$out" "$w" && bad="$bad $other"
    done
    [[ -z "$bad" ]] && pass "narrow: --source $src is the only source that holds '$w'" || fail "narrow: '$w' (only in $what) was also found with --source$bad"
}
check "$WT" tasks "a task body"
check "$WG" goals "a goal outcome"
check "$WP" messages "a board post"
check "$WC" history "an agent chat"
log "sample (history): $(head -3 "$TMP/found_history.out" | tr '\n' '|' | cut -c1-300)"

# ── The dashboard's search route returns the same hits ──────────────────────────────────────────────────
# The dashboard has one route per kind of source: tasks+goals (/search), board posts (/messages/search), chats (/api/sessions/history/search).
dash() { # dash <label> <word> <url>
    local code; code=$(curl -s -m 20 $COOKIE_ARGS -o "$TMP/dash_$1.out" -w "%{http_code}" "$3")
    if [[ $code == 200 ]] && grep -q "$2" "$TMP/dash_$1.out"; then pass "dashboard: $1 route finds $2"; else fail "dashboard: $1 route did not find $2: $code $(head -c 240 "$TMP/dash_$1.out")"; fi
}
dash tasks "$WT" "$BASE/api/board/$K/search?q=$WT"
dash goals "$WG" "$BASE/api/board/$K/search?q=$WG"
dash messages "$WP" "$BASE/api/board/$K/messages/search?q=$WP"
dash chats "$WC" "$BASE/api/sessions/history/search?q=$WC"

# ── The starting prompt names the command ───────────────────────────────────────────────────────────────
if grep -rqs "coral-board search" "$DUMP" "$DATA" 2>/dev/null; then pass "prompt: the agents' starting prompt names 'coral-board search'"; else
    log "no starting prompt was captured by the stand-in agent; the source pins are TestAgentPrompts in internal/agent (covered by go test)"; fi

log "RESULT: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
