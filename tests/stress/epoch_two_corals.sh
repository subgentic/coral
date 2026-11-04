#!/usr/bin/env bash
# Two isolated Corals on epoch for a throwaway hub to reach over SSH (#13079). Linux/epoch only; opt-in (EPOCH_RIG=1).
#
#   EPOCH_RIG=1 bash tests/stress/epoch_two_corals.sh /path/to/coral-binary
#
# Starts Coral A on 127.0.0.1:8461 and Coral B on 127.0.0.1:8462 (loopback only, so the hub reaches them with `ssh -W` / `ssh -L`), each with its own data folder under /sd2/$USER/qa-tmp, a sandbox HOME and the
# mock-agent stub CLIs first on PATH (tests/lib/mock_sandbox.sh: no real agent can start), telemetry off, --cloud-url off, the pty backend. It prints, for each, the port, the instance id and the API key (one
# line, "RIG <name> <port> <instance_id> <api_key>"), then stays in the foreground until it is stopped (Ctrl-C, SIGTERM) or EPOCH_RIG_MAX seconds (default 7200) pass. On exit it kills ONLY the PIDs it
# started and removes its data (KEEP_TEST_DATA=1 keeps it). It never touches ~/.coral, port 8420, or anything it did not start; it refuses to run if either port is in use.
# Seed one Coral before or after with the seeder of tests/latency (point it at the printed data folder). A hub registers them with the rig tool in coral-go/internal/store/rig_addssh_test.go (-tags rig).
set -uo pipefail
[ "${EPOCH_RIG:-}" = 1 ] || { echo "set EPOCH_RIG=1 (this is an opt-in rig for epoch)" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || [ "${EPOCH_RIG_ANY_OS:-}" = 1 ] || { echo "Linux (epoch) only: this never runs on the operator's Mac (EPOCH_RIG_ANY_OS=1 with QA_TMP=<a temp folder> only to check the script itself, a few seconds)" >&2; exit 2; }
BIN="${1:?usage: epoch_two_corals.sh /path/to/coral}"
[ -x "$BIN" ] || { echo "$BIN is not an executable" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QA="${QA_TMP:-/sd2/$USER/qa-tmp}/rig13079-$$"
PORT_A="${PORT_A:-8461}"; PORT_B="${PORT_B:-8462}"
MAX="${EPOCH_RIG_MAX:-7200}"
for p in "$PORT_A" "$PORT_B"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is in use: not starting" >&2; exit 3; fi
done
mkdir -p "$QA" || exit 1
PIDS=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null; done
  for d in "$QA/A" "$QA/B"; do CORAL_DATA_DIR="$d" coral_test_kill_tmux_server; done   # the tmux server on each Coral's own socket, nothing else
  [ "${KEEP_TEST_DATA:-}" = 1 ] || rm -rf "$QA"
  coral_test_sandbox_cleanup 2>/dev/null || true
}
trap cleanup EXIT INT TERM
# the sandbox: a temp HOME and stub CLIs for every agent, so nothing real starts
# shellcheck source=../lib/mock_sandbox.sh
source "$HERE/../lib/mock_sandbox.sh"
# shellcheck source=../lib/backend.sh
source "$HERE/../lib/backend.sh"
coral_test_sandbox
start() { # name port
  local name="$1" port="$2" dir="$QA/$1"
  mkdir -p "$dir"
  HOME="$CORAL_TEST_HOME" PATH="$CORAL_TEST_STUB_BIN:$PATH" CORAL_DATA_DIR="$dir" CORAL_TELEMETRY_DISABLED=1 \
    "$BIN" --host 127.0.0.1 --port "$port" --cloud-url off --no-browser --backend pty >"$QA/$name.log" 2>&1 &
  PIDS+=("$!")
  local i
  for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  local health iid key
  health="$(curl -sf "http://127.0.0.1:$port/api/health")" || { echo "Coral $name did not start; see $QA/$name.log" >&2; exit 4; }
  iid="$(printf '%s' "$health" | sed -n 's/.*"instance_id":"\([0-9a-f]*\)".*/\1/p')"
  key="$(HOME="$CORAL_TEST_HOME" "$BIN" api-key --home "$dir" 2>/dev/null)"
  echo "RIG $name $port ${iid:-?} ${key:-?}"
  echo "DATA $name $dir"
}
start A "$PORT_A"
start B "$PORT_B"
echo "READY: Coral A on 127.0.0.1:$PORT_A, Coral B on 127.0.0.1:$PORT_B; stop with Ctrl-C or kill $$ (also stops itself after ${MAX}s)"
SECONDS=0
while [ "$SECONDS" -lt "$MAX" ]; do
  for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || { echo "a Coral exited early; see $QA/*.log" >&2; exit 5; }; done
  sleep 5
done
