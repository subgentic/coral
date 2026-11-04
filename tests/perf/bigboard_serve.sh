#!/usr/bin/env bash
# bigboard_serve.sh (#13154): start the plain build on a COPY of a bigboard fixture with N awake mock agents (live tmux terminals), and leave it running,
# for a trace or a manual look (Frontend Dev's TYPING_TRACE=1 run, a profile). Prints the URL, the folders and the stop command.
#
#   PERF_RUN=1 FIXTURE=<fixture> RUN_DIR=<empty folder> [PORT=8742] [LIVE=30] [BIN=<a coral build to use instead of FIXTURE/bin/coral>] bash tests/perf/bigboard_serve.sh
#   stop it:  bash tests/perf/bigboard_serve.sh stop <RUN_DIR>       (kills only the PIDs and the tmux socket this run recorded)
#
# RUN_DIR/data is the copy (the fixture is never changed), RUN_DIR/home the sandbox HOME, RUN_DIR/pid the server's PID. The server listens on 127.0.0.1 only,
# --cloud-url off, --no-browser, never ~/.coral or :8420. Sign in a browser with the sign-in link in RUN_DIR/data/login_token (single use), or with the page's
# "Open Coral on this computer" button. To run a different build (a branch under test) pass BIN=<its coral>: its tools must be next to FIXTURE/bin's.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/bigboard_lib.sh"
if [[ "${1:-}" == stop ]]; then
  RD="${2:?usage: bigboard_serve.sh stop RUN_DIR}"
  [[ -f "$RD/pid" ]] || { echo "no $RD/pid"; exit 1; }
  PIDF="$(cat "$RD/pid")"
  # a stale pid file (after a reboot or a long run) can name an unrelated process: only a process whose command line is a coral with THIS run's --home is stopped
  if ! ps -o command= -p "$PIDF" 2>/dev/null | grep -qF -- "--home $RD/data"; then echo "pid $PIDF is not this run's coral (--home $RD/data): not stopping it"; stop_private_tmux "$RD/data/tmux.sock"; exit 1; fi
  kill "$PIDF" 2>/dev/null; for _ in $(seq 60); do kill -0 "$PIDF" 2>/dev/null || break; sleep 0.5; done; kill -9 "$PIDF" 2>/dev/null
  stop_private_tmux "$RD/data/tmux.sock"
  echo "stopped"; exit 0
fi
[[ "${PERF_RUN:-}" == 1 ]] || { echo "[bigboard-serve] opt-in: set PERF_RUN=1" >&2; exit 2; }
[[ -n "${FIXTURE:-}" && -f "$FIXTURE/fixture.json" && -x "$FIXTURE/bin/coral" && -n "${RUN_DIR:-}" ]] || { echo "[bigboard-serve] set FIXTURE (a bigboard_seed.sh fixture) and RUN_DIR" >&2; exit 2; }
PORT="${PORT:-8742}"; LIVE="${LIVE:-30}"; BIN="${BIN:-$FIXTURE/bin/coral}"
[[ "$PORT" != 8420 ]] || { echo "refusing :8420" >&2; exit 2; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is in use" >&2; exit 2; }
mkdir -p "$RUN_DIR"; RUN_DIR="$(cd "$RUN_DIR" && pwd)"; [[ -z "$(ls -A "$RUN_DIR")" ]] || { echo "RUN_DIR is not empty" >&2; exit 2; }
source "$HERE/../lib/mock_sandbox.sh"; coral_test_sandbox
cp -R "$FIXTURE/data" "$RUN_DIR/data"; rm -f "$RUN_DIR/data/coral-server.lock" "$RUN_DIR/data/login_token"; mkdir -p "$RUN_DIR/home"
env -u TMUX -u CORAL_CLOUD_URL -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u CORAL_SESSION_TOKEN -u CLAUDE_PROJECTS_DIR \
  HOME="$CORAL_TEST_HOME" USERPROFILE="$CORAL_TEST_HOME" PATH="$FIXTURE/bin:$CORAL_TEST_STUB_BIN:$PATH" CORAL_DATA_DIR="$RUN_DIR/data" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 \
  CODEX_HOME="$CORAL_TEST_HOME/codex" nohup "$BIN" --home "$RUN_DIR/data" --no-browser --host 127.0.0.1 --port "$PORT" --cloud-url off > "$RUN_DIR/server.log" 2>&1 &
echo $! > "$RUN_DIR/pid"
for _ in $(seq 600); do kill -0 "$(cat "$RUN_DIR/pid")" 2>/dev/null || { tail -20 "$RUN_DIR/server.log"; exit 1; }; curl -s -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.5; done
KEY="$(tr -d '[:space:]' < "$RUN_DIR/data/api_key")"; write_auth_header "$RUN_DIR/auth.hdr" "$KEY"
if [[ "$LIVE" -gt 0 ]]; then
  agents=""; for i in $(seq "$LIVE"); do agents="$agents${agents:+,}{\"agent_type\":\"claude\",\"name\":\"live-$i\",\"prompt\":\"You are live agent $i.\"}"; done
  command curl -s -m 300 -X POST "http://127.0.0.1:$PORT/api/sessions/launch-team" -H @"$RUN_DIR/auth.hdr" -H 'Content-Type: application/json' \
    -d "{\"board_name\":\"live\",\"working_dir\":\"$FIXTURE/repo\",\"agents\":[$agents]}" > "$RUN_DIR/launch.json"
  sleep 12
fi
command curl -s -m 30 "http://127.0.0.1:$PORT/api/sessions/live" -H @"$RUN_DIR/auth.hdr" | python3 -I -c 'import sys,json; d=json.load(sys.stdin); r=d if isinstance(d,list) else d.get("sessions",[]); print("agent rows:", len(r), " awake:", sum(1 for x in r if not x.get("sleeping")))'
echo "revision: $(cat "$FIXTURE/commit.txt") (the fixture's build); server binary: $BIN"
echo "URL: http://127.0.0.1:$PORT   sign-in link: http://127.0.0.1:$PORT/?login_token=$(cat "$RUN_DIR/data/login_token" 2>/dev/null)"
echo "run folder: $RUN_DIR   stop: PERF_RUN=1 bash $HERE/bigboard_serve.sh stop $RUN_DIR"
