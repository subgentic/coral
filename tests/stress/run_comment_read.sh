#!/usr/bin/env bash
# A comment on a file reaches a plain read (#14412, #14416): private server, one mock Orchestrator (MOCK_AGENT_IDLE=1: it makes no board reads of its own, which would take a message before the test reads it), real coral-board CLI. No model calls.
# The Orchestrator uploads a plan for review; the person (a dashboard cookie) asks for changes with words; the unread notice counts the comment, so a plain `coral-board read` as the agent MUST return it
# at once ("please read a comment on an artifact"), and the next plain read says nothing is new (it was read). Per backend: CORAL_TEST_BACKEND=tmux (default) or pty.
#   CORAL_TEST_PORT=8495 (default)
# Requires Go, Python 3.9+, Node, curl, and tmux (or CORAL_TEST_BACKEND=pty).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/agent_env.sh"
source "$SCRIPT_DIR/../lib/backend.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${CORAL_TEST_PORT:-8495}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 || 10#$PORT == 8420 )); then
    echo "ERROR: use a valid non-production port, never 8420." >&2
    exit 2
fi
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
SERVER_START=""
TMPDIR_SR=""
log() { echo "[comment-read] $*"; }
cleanup() {
    local result=$?
    trap - EXIT
    coral_test_watchdog_stop
    if [[ -n "$SERVER_PID" ]] && coral_test_same_process "$SERVER_PID" "$SERVER_START"; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    # Only this runner's socket; never the inherited/production tmux server.
    if [[ -n "${CORAL_DATA_DIR:-}" && -S "$CORAL_DATA_DIR/tmux.sock" ]]; then
        tmux -S "$CORAL_DATA_DIR/tmux.sock" kill-server 2>/dev/null || true
    fi
    if ! coral_test_sandbox_check; then result=1; fi
    coral_test_sandbox_cleanup
    local passed=0 failed=0
    if [[ -f "$TMPDIR_SR/comment-read-counts" ]]; then read -r passed failed < "$TMPDIR_SR/comment-read-counts"; fi
    if (( result != 0 && failed == 0 )); then failed=1; fi
    log "Runner totals: PASS=$passed FAIL=$failed"
    if [[ $result -ne 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then
        log "Retained private test data: $TMPDIR_SR"
    else
        coral_test_rm_tree "$TMPDIR_SR"
    fi
    exit "$result"
}
if coral_test_port_in_use "$PORT"; then
    echo "ERROR: port $PORT is in use; set CORAL_TEST_PORT to a free port." >&2
    exit 2
fi
TMPDIR_SR="$(mktemp -d "${TMPDIR:-/tmp}/coral-test-comment-read.XXXXXX")"
export TMPDIR="$TMPDIR_SR"
export CORAL_DATA_DIR="$TMPDIR_SR/coral-data"
export GOMAXPROCS="${GOMAXPROCS:-2}" GOMEMLIMIT="${GOMEMLIMIT:-512MiB}"
export CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1
export CORAL_TMUX_NO_FALLBACK=1
mkdir -p "$CORAL_DATA_DIR" "$TMPDIR_SR/env-dump" "$TMPDIR_SR/raw" "$TMPDIR_SR/work"
coral_test_sandbox
trap cleanup EXIT
coral_test_watchdog

log "Building isolated server, real board CLI, hooks and mock agent..."
(
    cd "$REPO_ROOT/coral-go"
    go build -p 1 -tags "dev fts5" -o "$TMPDIR_SR/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent \
        ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync
    go build -p 1 -o "$TMPDIR_SR/mock-agent${CORAL_TEST_EXE}" ./cmd/mock-agent
)
start_server() {
env -u CORAL_PORT -u CORAL_URL -u CLAUDE_PROJECTS_DIR -u GEMINI_TMP_DIR -u ANTIGRAVITY_DATA_DIR -u PI_CODING_AGENT_DIR \
    HOME="$(coral_test_native_path "$CORAL_TEST_HOME")" USERPROFILE="$(coral_test_native_path "$CORAL_TEST_HOME")" \
    CODEX_HOME="$(coral_test_native_path "$CORAL_TEST_HOME/.codex")" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    MOCK_AGENT_ENV_DUMP="$(coral_test_native_path "$TMPDIR_SR/env-dump")" \
    MOCK_AGENT_RAW_DIR="$(coral_test_native_path "$TMPDIR_SR/raw")" MOCK_AGENT_IDLE=1 \
    "$TMPDIR_SR/coral${CORAL_TEST_EXE}" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
    --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" \
    >"$TMPDIR_SR/server.log" 2>&1 &
    SERVER_PID=$!
    SERVER_START="$(coral_test_proc_start "$SERVER_PID")"
    [[ -n "$SERVER_START" ]] || { log "Cannot identify the server process"; exit 1; }
    command curl -sS --retry 8 --retry-connrefused --retry-max-time 40 --max-time 3 \
        -o /dev/null "$BASE_URL/api/health" 2>"$TMPDIR_SR/readiness.log"
    local link
    link=$("$TMPDIR_SR/coral${CORAL_TEST_EXE}" open --print --url "$BASE_URL" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
        | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1)
    [[ -n "$link" ]] || { log "Private server supplied no login link"; exit 1; }
    command curl -sS --max-time 10 -o /dev/null -c "$TMPDIR_SR/cookies.txt" "$link"
}
stop_server() {
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
}
driver() {
    python3 "$SCRIPT_DIR/send_after_restart.py" "$1" "$BASE_URL" "$(coral_test_native_path "$TMPDIR_SR")" "$CORAL_TEST_EXE" "$CORAL_TEST_BACKEND" "$(coral_test_native_path "$CORAL_TEST_HOME")" "$2" "${3:-}"
}
start_server
# agents launch the mock, never a CLI on this machine
command curl -sS --max-time 10 -o /dev/null -X PUT "$BASE_URL/api/settings" -b "$TMPDIR_SR/cookies.txt" -H "Content-Type: application/json" \
    -d "{\"cli_path_claude\": \"$(coral_test_native_path "$TMPDIR_SR/mock-agent${CORAL_TEST_EXE}")\"}"
BID=$(command curl -sS --max-time 30 -X POST "$BASE_URL/api/sessions/launch-team" -b "$TMPDIR_SR/cookies.txt" -H "Content-Type: application/json" \
    -d "{\"board_name\":\"builder\",\"working_dir\":\"$TMPDIR_SR/work\",\"agents\":[{\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"orch\"}]}" \
    | python3 -I -c "import sys,json; print(json.load(sys.stdin).get('board_id',''))")
[[ -n "$BID" ]] || { log "FAIL: the team did not launch"; exit 1; }
ENVFILE=""
for i in $(seq 1 40); do ENVFILE=$(grep -l "Orchestrator" "$TMPDIR_SR"/env-dump/*.coralenv 2>/dev/null | head -1 || true); [[ -n "$ENVFILE" ]] && break; sleep 0.5; done
[[ -n "$ENVFILE" ]] || { log "FAIL: the mock Orchestrator wrote no environment"; exit 1; }
orch() { ( cd "$TMPDIR_SR/work"; env $(grep -E '^CORAL_' "$ENVFILE" | tr '\n' ' ') PATH="$TMPDIR_SR:$PATH" "$@" ); }
printf '# Team plan: B\n\nGoal: ship the demo.\nDone when: tests pass.\n' > "$TMPDIR_SR/plan.md"
UP=$(orch coral-agent artifact upload "$TMPDIR_SR/plan.md" --name "Team plan: B" --tag "for review" --question "Launch this team? Approve to start." 2>&1) \
    || { log "FAIL: the upload failed: $UP"; exit 1; }
DIGEST=$(echo "$UP" | grep -oE '[0-9a-f]{64}' | head -1)
[[ -n "$DIGEST" ]] || { log "FAIL: no digest in the upload answer"; exit 1; }
ANS=$(command curl -sS --max-time 20 -X POST "$BASE_URL/api/board/$BID/artifacts/$DIGEST/review" -b "$TMPDIR_SR/cookies.txt" -H "Content-Type: application/json" \
    -d '{"decision":"changes","text":"Make the reviewer read-only and write the test command out."}')
echo "$ANS" | grep -q '"delivered":true' || { log "FAIL: the comment was not delivered: $ANS"; exit 1; }
# the unread count says one: that is what the agent's terminal is told
UNREAD=""
for i in $(seq 1 30); do
    UNREAD=$(orch coral-board check --quiet 2>/dev/null | tr -d '[:space:]' || true)
    [[ "$UNREAD" == "1" ]] && break
    sleep 0.5
done
log "unread count before the read: ${UNREAD:-unknown}"
FIRST=$(orch coral-board read 2>&1)
if ! echo "$FIRST" | grep -q "please read a comment on an artifact"; then
    log "FAIL: a plain read did not return the comment the unread count named: $(echo "$FIRST" | head -c 300)"
    echo "0 1" > "$TMPDIR_SR/comment-read-counts"; exit 1
fi
SECOND=$(orch coral-board read 2>&1)
if ! echo "$SECOND" | grep -q "No new messages"; then
    log "FAIL: the second plain read still had something: $(echo "$SECOND" | head -c 300)"
    echo "0 1" > "$TMPDIR_SR/comment-read-counts"; exit 1
fi
log "PASS: the first plain read returned the comment; the second had nothing new"
echo "1 0" > "$TMPDIR_SR/comment-read-counts"
coral_test_sandbox_check
