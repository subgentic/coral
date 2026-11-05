#!/usr/bin/env bash
#
# coral-board heavy run (#13750), end to end on an isolated Coral and the real mini: the pool grants the mini (the Mac's slot is taken), the worktree goes over ssh, the command runs there under the wrapper
# (coral-heavy-run) with an allowlisted environment, the output and exit code come back, the run folder is gone, and the slot is back. Not a CI test: it needs the mini and an ssh alias to it ("mini" in the
# Operator's own config), and it holds the mini while it runs. The wrapper runs with a HOME inside the caller's own mini folder (nothing outside it changes), as a plain command: the forced-command account is the
# Operator's step.
# Usage: MINI_HOME_DIR=/Users/you/coral-test/<you> tests/stress/run_heavy.sh     (CORAL_HEAVY_PORT default 8479, KEEP_TEST_DATA=1)
# Never touches ~/.coral or ports 8420/8450.
#
set -euo pipefail
export CORAL_TELEMETRY_DISABLED=1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORAL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/coral-go"
PORT="${CORAL_HEAVY_PORT:-8479}"
if [[ "$PORT" == 8420 || "$PORT" == 8450 ]]; then echo "ERROR: refusing port $PORT" >&2; exit 2; fi
: "${MINI_HOME_DIR:?set MINI_HOME_DIR to your own folder on the mini, e.g. /Users/you/coral-test/you}"
DEST="${HEAVY_TEST_DEST:-mini}"
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0; SERVER_PID=""
TMP="$(mktemp -d /tmp/chv.XXXXXX)"
DATA="$TMP/d"; BIN="$TMP/bin"; WT="$TMP/wt"
mkdir -p "$DATA" "$BIN" "$TMP/h" "$WT"
log()  { echo "[heavy] $*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
    ssh -o BatchMode=yes "$DEST" "rm -rf '$MINI_HOME_DIR/heavy-e2e-home'" >/dev/null 2>&1 || true
    if [[ $code -ne 0 || $FAIL -gt 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then log "Test data kept: $TMP"; else rm -rf "$TMP" 2>/dev/null || true; fi
    exit "$code"
}
trap cleanup EXIT
wait_until() { local limit=$1 what=$2; shift 2; local end=$((SECONDS + limit)); while ! "$@"; do if (( SECONDS >= end )); then fail "timed out waiting for $what"; return 1; fi; sleep 0.5; done; }

log "Building (the product wrapper for the mini, the dev coral-board with the test transport)..."
(cd "$CORAL_DIR" && go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent \
    && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o "$BIN/coral-heavy-run" ./cmd/coral-heavy-run) 2>&1 | grep -v "ld: warning" || true
H="$MINI_HOME_DIR/heavy-e2e-home"
ssh -o BatchMode=yes "$DEST" "rm -rf '$H' && mkdir -p '$H/bin' && ln -s \"\$HOME/.local\" '$H/.local'" 
scp -q -o BatchMode=yes "$BIN/coral-heavy-run" "$DEST:$H/bin/coral-heavy-run"
REMOTE="env HOME=$H $H/bin/coral-heavy-run"

env -u CORAL_CLOUD_URL HOME="$TMP/h" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 "$BIN/coral" --home "$DATA" --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --strict-local-auth=false >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
wait_until 30 "the server" curl -fsS -m 2 "$BASE/api/health" -o /dev/null || exit 1
op() { env -i PATH="$PATH" HOME="$TMP/h" CORAL_URL="$BASE" CORAL_DATA_DIR="$DATA" CORAL_DIR="$DATA" CORAL_SUBSCRIBER_ID=Operator "$BIN/coral-board" "$@"; }
heavy() { env -i PATH="$PATH" HOME="$TMP/h" CORAL_URL="$BASE" CORAL_DATA_DIR="$DATA" CORAL_DIR="$DATA" CORAL_SUBSCRIBER_ID=Operator CORAL_HEAVY_TEST_DEST="$DEST" CORAL_HEAVY_TEST_REMOTE="$REMOTE" "$@"; }
op resource define mac-heavy --slots 1 --machine Mac >/dev/null
op resource define mini --slots 1 --machine Mini >/dev/null
op resource define heavy --pool mac-heavy,mini >/dev/null && pass "the pool is defined" || fail "pool define"

# a worktree: tracked files, an untracked one, a secret-looking one, a script
git -C "$WT" init -q
mkdir -p "$WT/sub"
echo "hello from the worktree" > "$WT/hello.txt"
printf '#!/bin/sh\ncat ../hello.txt\necho "cwd=$(basename "$(pwd)") host=$(uname -n)"\necho "HOME=$HOME"\nenv | grep -c -E "GITHUB_TOKEN|ANTHROPIC|SSH_AUTH_SOCK|CORAL_URL" || true\nexit 5\n' > "$WT/sub/run.sh"; chmod +x "$WT/sub/run.sh"
echo "SECRET=1" > "$WT/.env"
echo "untracked, not ignored" > "$WT/new.txt"
git -C "$WT" add hello.txt sub/run.sh

# the Mac is taken by a hand claim of its own: the pool must give the mini
op resource claim mac-heavy >/dev/null
export GITHUB_TOKEN=ghp_should_not_travel ANTHROPIC_API_KEY=sk-should-not-travel
out=$(cd "$WT/sub" && GITHUB_TOKEN=$GITHUB_TOKEN heavy "$BIN/coral-board" heavy run -- "sh run.sh; ls ../.env 2>/dev/null || echo no-env-file; test -f ../new.txt && echo has-untracked" 2>&1) && code=0 || code=$?
echo "$out" | sed 's/^/    | /'
[[ "$out" == *"running on Mini"* ]] && pass "the pool gave the mini and the command ran there" || fail "not on the mini"
[[ "$out" == *"hello from the worktree"* && "$out" == *"cwd=sub"* ]] && pass "the worktree arrived and the command ran in the same subfolder" || fail "worktree or folder"
[[ "$out" == *"host=Chriss-Mac-mini"* || "$out" == *"host="*mini* ]] && pass "it ran on the mini's host" || fail "host line"
[[ "$out" == *"HOME=$H"* ]] && pass "the wrapper's own home, not the caller's" || fail "home"
[[ "$out" == *$'\n0\n'* ]] && pass "none of the caller's secrets reached the command (allowlisted environment)" || fail "environment leak or count missing"
[[ "$out" == *"no-env-file"* && "$out" == *"left out .env"* ]] && pass "the secret-looking file was not sent, and that was said" || fail ".env handling"
[[ "$out" == *"has-untracked"* ]] && pass "an untracked file that is not ignored was sent" || fail "untracked"
[[ $code -eq 0 ]] && pass "the last command's exit code (0) came back" || fail "exit code $code"
unset GITHUB_TOKEN ANTHROPIC_API_KEY
out=$(cd "$WT/sub" && heavy "$BIN/coral-board" heavy run -- "sh run.sh" 2>&1) && code=0 || code=$?
[[ $code -eq 5 ]] && pass "the command's own exit code (5) comes back" || fail "exit code was $code, wanted 5"
left=$(ssh -o BatchMode=yes "$DEST" "ls '$H/coral-test'/*/ 2>/dev/null | wc -l" | tr -d ' ')
[[ "$left" == "0" ]] && pass "no run folder is left on the mini" || fail "$left run folder(s) left"
[[ "$(op resource status mac-heavy | grep -c 'holds')" == "1" ]] && pass "only the hand claim holds the Mac; the pool's slot was given back" || fail "slots: $(op resource status heavy)"

# the time cap and the whole process group
out=$(cd "$WT/sub" && heavy "$BIN/coral-board" heavy run --timeout 3s -- "sleep 120" 2>&1) && code=0 || code=$?
[[ $code -eq 124 && "$out" == *"time cap"* ]] && pass "a command over its time cap is stopped (124) and the reason said" || fail "time cap: code $code: $out"
sleep 1
alive=$(ssh -o BatchMode=yes "$DEST" "ps -axo command | grep -c '[s]leep 120'" | tr -d ' ' || true)
[[ "${alive:-0}" == "0" ]] && pass "and nothing of it is left running on the mini" || fail "$alive sleep process(es) left on the mini"

# a Mac-only command is refused on the mini and the slot comes back
out=$(cd "$WT/sub" && heavy "$BIN/coral-board" heavy run -- "ls ~/.coral" 2>&1) && code=0 || code=$?
[[ $code -eq 2 && "$out" == *"Mac only"* ]] && pass "a command for the Mac only is refused on the mini" || fail "mac-only: code $code: $out"

log "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
