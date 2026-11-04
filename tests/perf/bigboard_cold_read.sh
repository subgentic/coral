#!/usr/bin/env bash
# bigboard_cold_read.sh (#13154, for #13292): a CPU profile of the FIRST reads after a server start on the big-board fixture, and what each took.
#
#   PERF_RUN=1 FIXTURE=<bigboard fixture> OUT=<empty folder> [BIN=<a coral build>] [SECONDS_PROFILE=8] [WAIT_BEFORE_S=0] bash tests/perf/bigboard_cold_read.sh
#
# Starts the plain build (or BIN) on a COPY of FIXTURE/data (own port 8746, pprof 8747, mock-agent sandbox, --cloud-url off), starts a CPU profile, then makes the page's first
# calls once each, timed: the board's artifacts list (cold), team-artifacts, the board's own tasks (/api/board/<id>/tasks), all boards' tasks, then the same artifacts list again (warm). OUT gets cold.pb.gz (read it with
# `go tool pprof -top -cum OUT/cold.pb.gz`), reads.txt (route, HTTP status, seconds, bytes) and the server log. Kills only its own server.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1
[[ "${PERF_RUN:-}" == 1 ]] || { echo "opt-in: set PERF_RUN=1" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/bigboard_lib.sh"
[[ -n "${FIXTURE:-}" && -f "$FIXTURE/fixture.json" && -n "${OUT:-}" ]] || { echo "set FIXTURE (a bigboard fixture) and OUT" >&2; exit 2; }
BIN="${BIN:-$FIXTURE/bin/coral}"; PORT=8746; PPORT=8747; SECS="${SECONDS_PROFILE:-8}"
for p in $PORT $PPORT; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $p is in use" >&2; exit 2; }; done
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; [[ -z "$(ls -A "$OUT")" ]] || { echo "OUT is not empty" >&2; exit 2; }
source "$HERE/../lib/mock_sandbox.sh"; coral_test_sandbox
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bigboard-cold.XXXXXX")"; SRV=""
cleanup() { [[ -n "$SRV" ]] && kill -0 "$SRV" 2>/dev/null && { kill "$SRV"; for _ in $(seq 60); do kill -0 "$SRV" 2>/dev/null || break; sleep 0.5; done; kill -9 "$SRV" 2>/dev/null; }; stop_private_tmux "$WORK/data/tmux.sock"; rm -rf -- "$WORK"; coral_test_sandbox_cleanup; }
trap cleanup EXIT
cp -R "$FIXTURE/data" "$WORK/data"; rm -f "$WORK/data/coral-server.lock" "$WORK/data/login_token"
env -u TMUX -u CORAL_CLOUD_URL -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u CORAL_SESSION_TOKEN -u CLAUDE_PROJECTS_DIR \
  HOME="$CORAL_TEST_HOME" USERPROFILE="$CORAL_TEST_HOME" PATH="$FIXTURE/bin:$CORAL_TEST_STUB_BIN:$PATH" CORAL_DATA_DIR="$WORK/data" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 \
  CODEX_HOME="$CORAL_TEST_HOME/codex" CORAL_PPROF_ADDR="127.0.0.1:$PPORT" "$BIN" --home "$WORK/data" --no-browser --host 127.0.0.1 --port "$PORT" --cloud-url off >"$OUT/server.log" 2>&1 &
SRV=$!
for _ in $(seq 240); do kill -0 "$SRV" 2>/dev/null || { tail -20 "$OUT/server.log"; exit 1; }; curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
KEY="$(tr -d '[:space:]' < "$WORK/data/api_key")"; write_auth_header "$WORK/auth.hdr" "$KEY"
BOARD="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["board"])' "$FIXTURE/fixture.json")"
get() { curl -s -m 120 -o "$WORK/response.body" -w "$1 %{http_code} %{time_total}s %{size_download}B\n" -H @"$WORK/auth.hdr" "http://127.0.0.1:$PORT$1"; }
# WAIT_BEFORE_S: seconds to wait after the server answers /api/health before the profile and the first call (default 0). A build that warms its caches at start (#13292) is measured twice: at 0
# (the first read races the warm) and at 5 (the warm has finished), to tell "the warm is done" from "the scan is still cold".
[[ "${WAIT_BEFORE_S:-0}" -gt 0 ]] && sleep "$WAIT_BEFORE_S"
echo "server up; board $BOARD; waited ${WAIT_BEFORE_S:-0} s after health; the first call comes right after the profile starts" | tee "$OUT/reads.txt"
curl -s -m $((SECS + 30)) -o "$OUT/cold.pb.gz" "http://127.0.0.1:$PPORT/debug/pprof/profile?seconds=$SECS" &
PROF=$!; sleep 1
{ get "/api/board/$BOARD/artifacts"; get "/api/team-artifacts"; get "/api/board/$BOARD/tasks"; get "/api/board/tasks"; get "/api/board/$BOARD/artifacts"; get "/api/board/$BOARD/artifacts?limit=50"; } | tee -a "$OUT/reads.txt"
wait "$PROF"
ls -la "$OUT/cold.pb.gz" | awk '{print "profile bytes", $5}' | tee -a "$OUT/reads.txt"
