#!/usr/bin/env bash
# bigboard_run.sh (#13154, goal #215): measure a Coral on the big-board fixture, locally and through a local Hub.
#
#   PERF_RUN=1 FIXTURE=<a bigboard_seed.sh fixture> OUT=<results folder> [HUB=1] [IDLE_S=60] bash tests/perf/bigboard_run.sh
#
# Copies FIXTURE/data (the fixture itself is never changed), starts the plain build FIXTURE/bin/coral on the copy (own port, mock-agent
# sandbox, --cloud-url off, --no-browser), and runs bigboard_measure.mjs against it: OUT/local.json. With HUB=1 it also starts a second
# coral --hub (its own empty data folder, own port), adds the first as a remote server over loopback (POST /api/servers, allow_private) and
# measures the same page through the hub: OUT/hub.json. Then bigboard_table.py writes OUT/ranked.md (worst first). A heavy run: announce
# it and run one at a time. Kills only the PIDs it started; never ~/.coral or :8420.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1
if [[ "${PERF_RUN:-}" != "1" ]]; then echo "[bigboard-run] opt-in: set PERF_RUN=1" >&2; exit 2; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -n "${FIXTURE:-}" && -f "$FIXTURE/fixture.json" && -x "$FIXTURE/bin/coral" ]] || { echo "[bigboard-run] FIXTURE must be a bigboard_seed.sh fixture" >&2; exit 2; }
[[ -n "${OUT:-}" ]] || { echo "[bigboard-run] set OUT to a results folder" >&2; exit 2; }
PORT="${PORT:-8742}"; HUBPORT="${HUBPORT:-8743}"; IDLE_S="${IDLE_S:-60}"
[[ "$PORT" != 8420 && "$HUBPORT" != 8420 ]] || { echo "[bigboard-run] refusing :8420" >&2; exit 2; }
for p in "$PORT" "$HUBPORT"; do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && { echo "[bigboard-run] port $p is in use" >&2; exit 2; }; done
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
source "$HERE/../lib/mock_sandbox.sh"
log() { echo "[bigboard-run] $*"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bigboard-run.XXXXXX")" || exit 1
PIDS=()
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null; done
  for _ in $(seq 60); do alive=0; for p in ${PIDS[@]+"${PIDS[@]}"}; do kill -0 "$p" 2>/dev/null && alive=1; done; [[ $alive == 0 ]] && break; sleep 0.5; done
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill -9 "$p" 2>/dev/null; done
  [[ -S "$WORK/data/tmux.sock" ]] && tmux -S "$WORK/data/tmux.sock" kill-server 2>/dev/null
  sleep 1; rm -rf -- "$WORK"; coral_test_sandbox_cleanup
}
trap cleanup EXIT
coral_test_sandbox

start() {  # start NAME BINARY DATADIR PORT [extra flags]: starts a server, sets LAST_PID, waits for health
  local name="$1" bin="$2" data="$3" port="$4"; shift 4
  env -u TMUX -u CORAL_CLOUD_URL -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u CORAL_SESSION_TOKEN -u CLAUDE_PROJECTS_DIR \
    HOME="$CORAL_TEST_HOME" USERPROFILE="$CORAL_TEST_HOME" PATH="$FIXTURE/bin:$CORAL_TEST_STUB_BIN:$PATH" CORAL_DATA_DIR="$data" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 \
    CODEX_HOME="$CORAL_TEST_HOME/codex" "$bin" --home "$data" --no-browser --host 127.0.0.1 --port "$port" --cloud-url off "$@" >"$OUT/$name.server.log" 2>&1 &
  LAST_PID=$!; PIDS+=("$LAST_PID")
  local t0; t0=$(date +%s.%N)
  for _ in $(seq 600); do
    kill -0 "$LAST_PID" 2>/dev/null || { log "$name exited"; tail -20 "$OUT/$name.server.log"; exit 1; }
    curl -s -m 2 "http://127.0.0.1:$port/api/health" >/dev/null && break; sleep 0.5
  done
  printf '%s: health after %.1f s\n' "$name" "$(awk -v a="$(date +%s.%N)" -v b="$t0" 'BEGIN{print a-b}')" | tee -a "$OUT/startup.txt"
}

measure() {  # measure LOGFILE ENV... -- ARGS: runs bigboard_measure.mjs, up to 3 tries (a headless Chrome sometimes does not open its DevTools port while the Mac is busy)
  local log="$1"; shift; local try rc=1
  for try in 1 2 3; do
    env PERF_RUN=1 "$@" > "$log" 2>&1; rc=$?
    [[ $rc == 0 ]] && break
    echo "measure try $try failed (exit $rc): $(grep -m1 'Error' "$log" | cut -c1-120)"; sleep 5
  done
  return $rc
}
{ echo "commit $(cat "$FIXTURE/commit.txt")"; echo "load $(uptime | sed 's/.*load averages*: //')"; sysctl -n machdep.cpu.brand_string 2>/dev/null; } > "$OUT/machine.txt"
log "copying the fixture data"
cp -R "$FIXTURE/data" "$WORK/data"
rm -f "$WORK/data/coral-server.lock" "$WORK/data/login_token"
PPROF_PORT="${PPROF_PORT:-8744}"
export CORAL_PPROF_ADDR="127.0.0.1:$PPROF_PORT"; [[ -n "${DEBUG_PHASES:-}" ]] && export CORAL_DEBUG_PHASES=1   # the measured server only (the hub must not bind the same address)
start local "$FIXTURE/bin/coral" "$WORK/data" "$PORT"
unset CORAL_PPROF_ADDR CORAL_DEBUG_PHASES
SRV=$LAST_PID
KEY="$(tr -d '[:space:]' < "$WORK/data/api_key")"
api() { local m="$1" p="$2"; shift 2; command curl -s -m 120 -X "$m" "http://127.0.0.1:$PORT$p" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" "$@"; }
# LIVE: the counts of live mock agents (in tmux, working in the fixture's big repo) the page is measured at; each step adds agents to the server it is on
LIVE="${LIVE:-0 30}"; launched=0; LAST_N=0
for n in $LIVE; do
  need=$((n - launched))
  if [[ $need -gt 0 ]]; then
    log "launching $need live mock agents (to $n)"
    agents=""; for i in $(seq "$need"); do agents="$agents${agents:+,}{\"agent_type\":\"claude\",\"name\":\"live$n-$i\",\"prompt\":\"You are live agent $i.\"}"; done
    api POST /api/sessions/launch-team -d "{\"board_name\":\"live$n\",\"working_dir\":\"$FIXTURE/repo\",\"agents\":[$agents]}" > "$OUT/launch-$n.json"
    launched=$n; sleep 12
  fi
  api GET /api/sessions/live | python3 -I -c 'import sys,json; d=json.load(sys.stdin); r=d if isinstance(d,list) else d.get("sessions",[]); print("live rows:", len(r), "sleeping:", sum(1 for x in r if x.get("sleeping")))' | tee -a "$OUT/machine.txt"
  sleep 5
  log "measuring locally with $n live agents (idle ${IDLE_S}s)"
  measure "$OUT/local-$n.log" IDLE_S="$IDLE_S" PPROF_URL="http://127.0.0.1:$PPROF_PORT" PROFILE_PREFIX="$OUT/cpu-$n-agents" node "$HERE/bigboard_measure.mjs" "http://127.0.0.1:$PORT" "" "$OUT/local-$n.json"; echo "local-$n measure exit=$?"
  ps -o rss= -p "$SRV" | awk -v n="$n" '{printf "server RSS at %s live agents: %.0f MB\n", n, $1/1024}' | tee -a "$OUT/machine.txt"
  LAST_N=$n
done

if [[ "${HUB:-}" == 1 ]]; then
  mkdir -p "$WORK/hub"
  start hub "$FIXTURE/bin/coral" "$WORK/hub" "$HUBPORT" --hub
  HUBKEY="$(tr -d '[:space:]' < "$WORK/hub/api_key")"
  code=$(curl -s -m 60 -o "$OUT/hub-add.json" -w '%{http_code}' -X POST "http://127.0.0.1:$HUBPORT/api/servers" -H "Authorization: Bearer $HUBKEY" -H 'Content-Type: application/json' \
    -d "{\"id\":\"bigboard\",\"label\":\"bigboard\",\"url\":\"http://127.0.0.1:$PORT\",\"api_key\":\"$KEY\",\"allow_private\":true}")
  log "hub add server: HTTP $code"; head -c 300 "$OUT/hub-add.json"; echo
  sleep 5
  log "measuring through the hub with $LAST_N live agents (idle ${IDLE_S}s)"
  measure "$OUT/hub.log" IDLE_S="$IDLE_S" node "$HERE/bigboard_measure.mjs" "http://127.0.0.1:$HUBPORT" "$WORK/hub/login_token" "$OUT/hub-$LAST_N.json"; echo "hub measure exit=$?"
fi
python3 -I "$HERE/bigboard_table.py" "$OUT" > "$OUT/ranked.md" && head -40 "$OUT/ranked.md"
log "results in $OUT"
