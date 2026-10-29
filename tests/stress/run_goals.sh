#!/usr/bin/env bash
# Goals integration: private server, mock agents, real coral-board CLI. No model calls.
#   CORAL_TEST_REPEAT=N runs the whole driver N times back to back on this one server (each round has its own boards).
# Requires Go, Python 3.9+, Node, curl, and tmux (or CORAL_TEST_BACKEND=pty).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/agent_env.sh"
source "$SCRIPT_DIR/../lib/backend.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${CORAL_TEST_PORT:-8493}"
REPEAT="${CORAL_TEST_REPEAT:-1}"
[[ "$REPEAT" =~ ^[0-9]+$ ]] && (( 10#$REPEAT >= 1 )) || { echo "ERROR: CORAL_TEST_REPEAT is a number from 1." >&2; exit 2; }
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 || 10#$PORT == 8420 )); then
    echo "ERROR: use a valid non-production port, never 8420." >&2
    exit 2
fi
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
SERVER_START=""
TMPDIR_GOALS=""
log() { echo "[goals] $*"; }
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
    if [[ -f "$TMPDIR_GOALS/goals-counts" ]]; then
        read -r passed failed < "$TMPDIR_GOALS/goals-counts"
    fi
    if (( result != 0 && failed == 0 )); then failed=1; fi
    log "Runner totals: PASS=$passed FAIL=$failed"
    if [[ $result -ne 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then
        log "Retained private test data: $TMPDIR_GOALS"
    else
        coral_test_rm_tree "$TMPDIR_GOALS"
    fi
    exit "$result"
}
if coral_test_port_in_use "$PORT"; then
    echo "ERROR: port $PORT is in use; set CORAL_TEST_PORT to a free port." >&2
    exit 2
fi
TMPDIR_GOALS="$(mktemp -d "${TMPDIR:-/tmp}/coral-test-goals.XXXXXX")"
export TMPDIR="$TMPDIR_GOALS"
export CORAL_DATA_DIR="$TMPDIR_GOALS/coral-data"
export GOMAXPROCS="${GOMAXPROCS:-2}" GOMEMLIMIT="${GOMEMLIMIT:-512MiB}"
export CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1
export CORAL_TMUX_NO_FALLBACK=1
mkdir -p "$CORAL_DATA_DIR" "$TMPDIR_GOALS/env-dump" "$TMPDIR_GOALS/work"
coral_test_sandbox
trap cleanup EXIT
coral_test_watchdog

log "Building isolated server, real board CLI, hooks and mock agent..."
(
    cd "$REPO_ROOT/coral-go"
    go build -p 1 -tags "dev fts5" -o "$TMPDIR_GOALS/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent \
        ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync
    go build -p 1 -o "$TMPDIR_GOALS/mock-agent${CORAL_TEST_EXE}" ./cmd/mock-agent
)
env -u CORAL_PORT -u CORAL_URL -u CLAUDE_PROJECTS_DIR -u GEMINI_TMP_DIR -u ANTIGRAVITY_DATA_DIR -u PI_CODING_AGENT_DIR \
    HOME="$(coral_test_native_path "$CORAL_TEST_HOME")" USERPROFILE="$(coral_test_native_path "$CORAL_TEST_HOME")" \
    CODEX_HOME="$(coral_test_native_path "$CORAL_TEST_HOME/.codex")" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    MOCK_AGENT_ENV_DUMP="$(coral_test_native_path "$TMPDIR_GOALS/env-dump")" \
    "$TMPDIR_GOALS/coral${CORAL_TEST_EXE}" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
    --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" \
    >"$TMPDIR_GOALS/server.log" 2>&1 &
SERVER_PID=$!
SERVER_START="$(coral_test_proc_start "$SERVER_PID")"
[[ -n "$SERVER_START" ]] || { log "Cannot identify the server process"; exit 1; }
# Bounded connection readiness; the private login below also verifies the responding server.
command curl -sS --retry 8 --retry-connrefused --retry-max-time 40 --max-time 3 \
    -o /dev/null "$BASE_URL/api/health" 2>"$TMPDIR_GOALS/readiness.log"
JAR="$TMPDIR_GOALS/cookies.txt"
LINK=$("$TMPDIR_GOALS/coral${CORAL_TEST_EXE}" open --print --url "$BASE_URL" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
    | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1)
[[ -n "$LINK" ]] || { log "Private server supplied no login link"; exit 1; }
command curl -sS --max-time 10 -o /dev/null -c "$JAR" "$LINK"
unset LINK
log "Running goals integration on $BASE_URL ($CORAL_TEST_BACKEND)..."
for round in $(seq 1 "$REPEAT"); do
    (( REPEAT == 1 )) || log "Round $round/$REPEAT"
    python3 "$SCRIPT_DIR/goals_integration.py" "$BASE_URL" "$(coral_test_native_path "$TMPDIR_GOALS")" "$CORAL_TEST_EXE" "$CORAL_TEST_BACKEND" "$(coral_test_native_path "$CORAL_TEST_HOME")" "r$round"
    read -r p f < "$TMPDIR_GOALS/goals-counts"; ROUND_PASS=$(( ${ROUND_PASS:-0} + p ))
done
echo "$ROUND_PASS 0" > "$TMPDIR_GOALS/goals-counts"  # the runner's totals add up every round
coral_test_sandbox_check
