#!/usr/bin/env bash
# Same-computer team links: private server, three mock teams, the real coral-board CLI as the Operator and as agents. No model calls.
# Requires Go, Python 3.9+, Node, curl, and tmux (or CORAL_TEST_BACKEND=pty).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/agent_env.sh"
source "$SCRIPT_DIR/../lib/backend.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT="${CORAL_TEST_PORT:-8497}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 || 10#$PORT == 8420 )); then
    echo "ERROR: use a valid non-production port, never 8420." >&2
    exit 2
fi
BASE_URL="http://127.0.0.1:$PORT"
SERVER_PID=""
SERVER_START=""
TMPDIR_LINKS=""
log() { echo "[team-links] $*"; }
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
    if [[ -f "$TMPDIR_LINKS/links-counts" ]]; then
        read -r passed failed < "$TMPDIR_LINKS/links-counts"
    fi
    if (( result != 0 && failed == 0 )); then failed=1; fi
    log "Runner totals: PASS=$passed FAIL=$failed"
    if [[ $result -ne 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then
        log "Retained private test data: $TMPDIR_LINKS"
    else
        coral_test_rm_tree "$TMPDIR_LINKS"
    fi
    exit "$result"
}
if coral_test_port_in_use "$PORT"; then
    echo "ERROR: port $PORT is in use; set CORAL_TEST_PORT to a free port." >&2
    exit 2
fi
TMPDIR_LINKS="$(mktemp -d "${TMPDIR:-/tmp}/coral-test-links.XXXXXX")"
export TMPDIR="$TMPDIR_LINKS"
export CORAL_DATA_DIR="$TMPDIR_LINKS/coral-data"
export GOMAXPROCS="${GOMAXPROCS:-2}" GOMEMLIMIT="${GOMEMLIMIT:-512MiB}"
export CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1
export CORAL_TMUX_NO_FALLBACK=1
mkdir -p "$CORAL_DATA_DIR" "$TMPDIR_LINKS/env-dump" "$TMPDIR_LINKS/work"
coral_test_sandbox
trap cleanup EXIT
coral_test_watchdog

log "Building isolated server, real board CLI, hooks and mock agent..."
(
    cd "$REPO_ROOT/coral-go"
    go build -p 1 -tags "dev fts5" -o "$TMPDIR_LINKS/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent \
        ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync
    go build -p 1 -o "$TMPDIR_LINKS/mock-agent${CORAL_TEST_EXE}" ./cmd/mock-agent
)
env -u CORAL_PORT -u CORAL_URL -u CLAUDE_PROJECTS_DIR -u GEMINI_TMP_DIR -u ANTIGRAVITY_DATA_DIR -u PI_CODING_AGENT_DIR \
    HOME="$(coral_test_native_path "$CORAL_TEST_HOME")" USERPROFILE="$(coral_test_native_path "$CORAL_TEST_HOME")" \
    CODEX_HOME="$(coral_test_native_path "$CORAL_TEST_HOME/.codex")" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    MOCK_AGENT_ENV_DUMP="$(coral_test_native_path "$TMPDIR_LINKS/env-dump")" \
    "$TMPDIR_LINKS/coral${CORAL_TEST_EXE}" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
    --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" \
    >"$TMPDIR_LINKS/server.log" 2>&1 &
SERVER_PID=$!
SERVER_START="$(coral_test_proc_start "$SERVER_PID")"
[[ -n "$SERVER_START" ]] || { log "Cannot identify the server process"; exit 1; }
# Bounded connection readiness; the private login below also verifies the responding server.
command curl -sS --retry 8 --retry-connrefused --retry-max-time 40 --max-time 3 \
    -o /dev/null "$BASE_URL/api/health" 2>"$TMPDIR_LINKS/readiness.log"
JAR="$TMPDIR_LINKS/cookies.txt"
LINK=$("$TMPDIR_LINKS/coral${CORAL_TEST_EXE}" open --print --url "$BASE_URL" --home "$(coral_test_native_path "$CORAL_DATA_DIR")" \
    | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1)
[[ -n "$LINK" ]] || { log "Private server supplied no login link"; exit 1; }
command curl -sS --max-time 10 -o /dev/null -c "$JAR" "$LINK"
unset LINK
log "Running team-links integration on $BASE_URL ($CORAL_TEST_BACKEND)..."
python3 "$SCRIPT_DIR/team_links_integration.py" "$BASE_URL" "$(coral_test_native_path "$TMPDIR_LINKS")" "$CORAL_TEST_EXE" "$CORAL_TEST_BACKEND" "$(coral_test_native_path "$CORAL_TEST_HOME")"
coral_test_sandbox_check
