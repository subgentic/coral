#!/usr/bin/env bash
# Send after restart (Goal #133, #10813, #10996): private server, mock agents, real coral-board CLI. No model calls.
# Launches a team, sends once, RESTARTS Coral (same data dir; the agents' terminals survive), then sends as the dashboard's
# composer does: to each agent, after a sleep and wake, and while a board nudge is due. Each send must be 200, land in the
# terminal, and never say `session target mismatch` or `not_submitted`. The request goes to the server directly: the handler
# the Hub tunnel reaches (no Hub is started); see send_after_restart.py.
#   CORAL_TEST_PORT=8494 (default)   CORAL_TEST_REPEAT=N runs the before/restart/after round N times on one server
#                                    (each round restarts Coral again, with its own team).
# Requires Go, Python 3.9+, Node, curl, and tmux (or CORAL_TEST_BACKEND=pty).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/agent_env.sh"
source "$SCRIPT_DIR/../lib/backend.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${CORAL_TEST_PORT:-8494}"
REPEAT="${CORAL_TEST_REPEAT:-1}"
[[ "$REPEAT" =~ ^[0-9]+$ ]] && (( 10#$REPEAT >= 1 )) || { echo "ERROR: CORAL_TEST_REPEAT is a number from 1." >&2; exit 2; }
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 || 10#$PORT == 8420 )); then
    echo "ERROR: use a valid non-production port, never 8420." >&2
    exit 2
fi
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
SERVER_START=""
TMPDIR_SR=""
log() { echo "[send-restart] $*"; }
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
    if [[ -f "$TMPDIR_SR/send-restart-counts" ]]; then
        read -r passed failed < "$TMPDIR_SR/send-restart-counts"
    fi
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
TMPDIR_SR="$(mktemp -d "${TMPDIR:-/tmp}/coral-test-send-restart.XXXXXX")"
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
for round in $(seq 1 "$REPEAT"); do
    [[ -n "$SERVER_PID" ]] || start_server  # round 2 on continues on the server round 1 left running
    log "Round $round/$REPEAT: launch and send before the restart..."
    driver before "r$round"
    log "Restarting Coral (same data dir)..."
    stop_server
    driver diverge "r$round" "$CORAL_DATA_DIR/sessions.db"
    start_server
    log "Round $round/$REPEAT: send after the restart..."
    driver after "r$round"
    passed_rounds=$round
done
echo "$passed_rounds 0" > "$TMPDIR_SR/send-restart-counts"
coral_test_sandbox_check
