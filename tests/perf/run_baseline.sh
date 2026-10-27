#!/usr/bin/env bash
# run_baseline.sh PHASE  -- the Goal #85 baseline (#9086): a BIG seeded isolated Coral, its hot routes and its dashboard screens, measured. Opt-in and epoch-sized: it seeds 5,000 tasks, 50,000 board
# messages, 2,000 artifacts and 30 agents, so it refuses to run unless PERF_RUN=1 is set and WORK names a folder under /tmp, /sd2 or the user's own tree (never ~/.coral).
#
#   PERF_RUN=1 WORK=/sd2/$USER/coralgo-perf9086 REPO=/path/to/worktree GO=$HOME/go-install/go/bin/go bash tests/perf/run_baseline.sh all
#
# Phases (each can be run on its own, so a pause can resume): build, seed, serve, routes, browser, stop, clean. "all" is build seed serve routes browser stop. The server, Chrome and every other process are
# started with their pids recorded in $WORK/pids and only those are killed. The server is a dev build (it has the loopback profiler, CORAL_PPROF_ADDR) on a free port, --cloud-url off, no browser, an
# empty PATH of agent CLIs, its own HOME and CORAL_DATA_DIR. Env: CHROME (required for the browser phase: the Chrome binary), PORT (default 23450), CDP_PORT (23451), PPROF_PORT (23452), N (routes samples, 30), RUNS (browser runs, 5), NODE, SEEDARGS, CRI.
set -u
PHASE="${1:-all}"
[[ "${PERF_RUN:-}" == 1 ]] || { echo "set PERF_RUN=1 (this seeds a big dataset and is meant for epoch)"; exit 2; }
WORK="${WORK:?WORK is the folder everything goes in}"
case "$WORK" in "$HOME/.coral"*|"$HOME") echo "refusing WORK=$WORK"; exit 2;; /tmp/*|/sd2/*|"$HOME"/*) ;; *) echo "refusing WORK=$WORK"; exit 2;; esac
REPO="${REPO:?REPO is the checkout (a worktree of the commit to measure)}"
GO="${GO:-go}"; NODE="${NODE:-node}"
PORT="${PORT:-23450}"; CDP_PORT="${CDP_PORT:-23451}"; PPROF_PORT="${PPROF_PORT:-23452}"; N="${N:-30}"; RUNS="${RUNS:-5}"
CHROME="${CHROME:-}"
BIN="$WORK/bin"; DATA="$WORK/data"; HOMEDIR="$WORK/home"; OUT="$WORK/out"; PIDS="$WORK/pids"
mkdir -p "$WORK" "$BIN" "$OUT" "$HOMEDIR"

have_pid() { [[ -f "$PIDS" ]] && grep -q "^$1 " "$PIDS"; }
record() { echo "$1 $2" >> "$PIDS"; }
# a recorded pid is signalled only while its command line still names this run's folder (a pids file left by a crashed run could name a pid that was reused since)
mine() { local c; c=$(ps -o args= -p "$1" 2>/dev/null); case "$c" in *"$WORK"*) return 0 ;; *) return 1 ;; esac; }
stop() {
  [[ -f "$PIDS" ]] || return 0
  while read -r name pid; do mine "$pid" && kill "$pid" 2>/dev/null && echo "stopped $name $pid"; done < "$PIDS"
  sleep 2
  while read -r name pid; do mine "$pid" && kill -9 "$pid" 2>/dev/null; done < "$PIDS"
  rm -f "$PIDS"
}
trap 'true' EXIT

phase_build() {
  rm -rf "$REPO/coral-go/cmd/perfseed"; cp -r "$REPO/tests/perf/seed" "$REPO/coral-go/cmd/perfseed"
  ( cd "$REPO/coral-go" && "$GO" build -tags "dev fts5" -o "$BIN/perfseed" ./cmd/perfseed && "$GO" build -tags "dev fts5" -o "$BIN/coral" ./cmd/coral ) || { rm -rf "$REPO/coral-go/cmd/perfseed"; return 1; }
  rm -rf "$REPO/coral-go/cmd/perfseed"
  ( cd "$REPO" && git rev-parse HEAD ) > "$OUT/commit.txt" 2>/dev/null || true
}
phase_seed() {
  [[ -e "$DATA/messageboard.db" ]] && { echo "seeded data is there already: $DATA (clean first to reseed)"; return 0; }
  # shellcheck disable=SC2086
  "$BIN/perfseed" -datadir "$DATA" -projects "$WORK/projects" -out "$OUT/targets.json" ${SEEDARGS:-} | tee "$OUT/seed.log"
}
port_free() { python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.5); sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) != 0 else 1)' "$1"; }
phase_serve() {
  have_pid server && { echo "server already running"; return 0; }
  for p in "$PORT" "$CDP_PORT" "$PPROF_PORT"; do port_free "$p" || { echo "port $p is in use: set PORT, CDP_PORT and PPROF_PORT to free ones"; return 2; }; done
  # exec: $! is the server itself (a first run recorded the subshell's pid, so the CPU and memory samples were of a shell)
  ( cd "$WORK" && exec env -i HOME="$HOMEDIR" PATH=/usr/bin:/bin TMPDIR="$WORK/tmp" CORAL_DATA_DIR="$DATA" CLAUDE_PROJECTS_DIR="$WORK/projects" CORAL_PPROF_ADDR="127.0.0.1:$PPROF_PORT" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TELEMETRY_DISABLED=1 \
      "$BIN/coral" --host 127.0.0.1 --port "$PORT" --cloud-url off --no-browser --strict-local-auth=false > "$OUT/server.log" 2>&1 ) & echo $! > "$WORK/server.pid"
  mkdir -p "$WORK/tmp"
  record server "$(cat "$WORK/server.pid")"
  for i in $(seq 1 120); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 1; done
  curl -s -o /dev/null -w 'health %{http_code}\n' "http://127.0.0.1:$PORT/api/health"
  sleep 15 # the startup's own background work (indexer, reconcilers) settles before anything is measured
}
phase_routes() {
  local pid; pid="$(grep '^server ' "$PIDS" | awk '{print $2}')"
  python3 "$REPO/tests/perf/routes.py" --base "http://127.0.0.1:$PORT" --targets "$OUT/targets.json" --pid "$pid" --key "$(cat "$DATA/api_key" 2>/dev/null)" --n "$N" --out "$OUT/routes.json" | tee "$OUT/routes.txt"
}
phase_browser() {
  [[ -n "$CHROME" && -x "$CHROME" ]] || { echo "CHROME must name the headless Chrome binary for the browser phase (none is assumed)"; return 2; }
  have_pid chrome || {
    rm -rf "$WORK/chrome-profile"
    "$CHROME" --headless=new --no-sandbox --disable-gpu --remote-debugging-port="$CDP_PORT" --user-data-dir="$WORK/chrome-profile" --no-first-run about:blank > "$OUT/chrome.log" 2>&1 &
    record chrome $!
    for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version" && break; sleep 1; done
  }
  CORAL_TEST_URL="http://127.0.0.1:$PORT" CDP_PORT="$CDP_PORT" TARGETS="$OUT/targets.json" RUNS="$RUNS" OUT="$OUT/browser.json" CRI="${CRI:-}" "$NODE" "$REPO/tests/perf/browser.js" | tee "$OUT/browser.txt"
}
phase_clean() { stop; rm -rf "$WORK/data" "$WORK/projects" "$WORK/home" "$WORK/chrome-profile" "$WORK/tmp" "$WORK/bin" "$WORK/pids" "$WORK/server.pid"; echo "cleaned the folders under $WORK (out/ kept)"; }

case "$PHASE" in
  all) phase_build && phase_seed && phase_serve && phase_routes && phase_browser; rc=$?; stop; exit $rc ;;
  build) phase_build ;; seed) phase_seed ;; serve) phase_serve ;; routes) phase_routes ;; browser) phase_browser ;;
  stop) stop ;; clean) phase_clean ;;
  *) echo "phase: build|seed|serve|routes|browser|stop|clean|all"; exit 2 ;;
esac
