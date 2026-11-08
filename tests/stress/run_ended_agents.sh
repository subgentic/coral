#!/usr/bin/env bash
#
# Agents that Kill All ended (#14172, #14208): Wake Team must say who did not start, and an inbox Restart must resume the ended agent's chat.
#
# A small team of mock agents on an isolated server, on the backend CORAL_TEST_BACKEND (tmux by default, or pty). The team's Kill All is the dashboard's route
# (POST .../team/<board>/kill); then Wake Team (POST .../team/<board>/wake) is called and what it answers, what the live list shows and what the server log says are printed; then the
# inbox Restart's two calls (the member's resume-info, then the launch with resume_session_id on the team's board) are made as the dashboard's resume does. It is an observation,
# not a pass/fail proof: run it on a build before the fix and on the fix, and compare the printed lines.
#
# Usage: CORAL_SRC_DIR=<coral-go tree> CORAL_TEST_BACKEND=pty|tmux CORAL_TEST_PORT=<port> bash tests/stress/run_ended_agents.sh
# Env:   CORAL_SRC_DIR (default this repo's coral-go), CORAL_TEST_PORT (default 8479; 8420 refused), KEEP_TEST_DATA=1.
# Safety: its own data dir under /tmp, its own tmux socket, --cloud-url off, --no-browser, telemetry off; it stops only the processes it started (by PID, never by name).
#
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/agent_env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/backend.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORAL_SRC="${CORAL_SRC_DIR:-$REPO_ROOT/coral-go}"
PORT=${CORAL_TEST_PORT:-8479}
if [[ "$PORT" == 8420 ]]; then echo "ERROR: refusing port 8420 (production Coral server)." >&2; exit 2; fi
HOST="127.0.0.1"; BASE_URL="http://${HOST}:${PORT}"
SERVER_PID=""
log() { echo "[ended-agents/$CORAL_TEST_BACKEND] $*"; }
api() { local m="$1" p="$2"; shift 2; curl -s -m 20 -X "$m" "${BASE_URL}${p}" -H "Content-Type: application/json" "$@"; }

TMP="$(mktemp -d /tmp/coral-ended.XXXXXX)"
export TMPDIR="$TMP" CORAL_DATA_DIR="$TMP/data" CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TMUX_NO_FALLBACK=1 MOCK_AGENT_TRANSCRIPT=1
SOCK="$CORAL_DATA_DIR/tmux.sock"; WORK="$TMP/proj"
mkdir -p "$CORAL_DATA_DIR" "$WORK" "$TMP/host-home"

# Every descendant of a PID, so the server and the agents under it are stopped by their own PIDs.
descendants() { local p; for p in $(ps -axo pid=,ppid= | awk -v P="$1" '$2 == P {print $1}'); do echo "$p"; descendants "$p"; done; }
cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]]; then
        local kids; kids="$(descendants "$SERVER_PID")"
        kill "$SERVER_PID" 2>/dev/null || true
        for p in $kids; do kill "$p" 2>/dev/null || true; done
        sleep 1
        for p in $kids "$SERVER_PID"; do kill -9 "$p" 2>/dev/null || true; done
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    [[ "$CORAL_TEST_BACKEND" == tmux ]] && tmux -S "$SOCK" kill-server 2>/dev/null || true
    log "stopped the server and its agents by PID"
    if [[ ${KEEP_TEST_DATA:-0} == 1 ]]; then log "data and server log kept: $TMP"; else cp "$TMP/server.log" "/tmp/coral-ended-last-$CORAL_TEST_BACKEND.log" 2>/dev/null; rm -rf "$TMP"; fi
    coral_test_sandbox_cleanup 2>/dev/null || true
    exit "$code"
}
trap cleanup EXIT
coral_test_port_in_use "$PORT" && { log "ERROR: port $PORT is in use"; exit 1; }

log "building coral and mock-agent from $CORAL_SRC ($(git -C "$CORAL_SRC" rev-parse --short HEAD 2>/dev/null))"
(cd "$CORAL_SRC" && go build -tags "dev fts5" -o "$TMP/coral" ./cmd/coral/ && go build -o "$TMP/mock-agent" ./cmd/mock-agent/) || { log "ERROR: build failed"; exit 1; }
coral_test_sandbox 2>/dev/null || true
env -u CORAL_PORT -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u TMUX -u TMUX_PANE HOME="$TMP/host-home" \
    "$TMP/coral" --home "$CORAL_DATA_DIR" --no-browser --cloud-url off --host "$HOST" --port "$PORT" --backend "$CORAL_TEST_BACKEND" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 80); do
    grep -q "Coral dashboard: http://localhost:${PORT}" "$TMP/server.log" 2>/dev/null && break
    kill -0 "$SERVER_PID" 2>/dev/null || { log "ERROR: server exited"; tail -15 "$TMP/server.log"; exit 1; }
    sleep 0.5
done
api PUT "/api/settings" -d "{\"cli_path_claude\": \"$TMP/mock-agent\"}" >/dev/null

live() { api GET "/api/sessions/live" | python3 -c '
import json, sys
d = json.load(sys.stdin); d = d if isinstance(d, list) else d.get("sessions", [])
for s in d: print("\t".join(str(x) for x in (s.get("session_id"), s.get("display_name"), s.get("board_project") or "-", "asleep" if s.get("sleeping") else "awake", s.get("name"))))'; }

log "launching a team of 3 on the $CORAL_TEST_BACKEND backend"
launch=$(api POST "/api/sessions/launch-team" -d "{\"board_name\": \"ended-team\", \"working_dir\": \"$WORK\", \"backend\": \"$CORAL_TEST_BACKEND\",
  \"agents\": [{\"agent_type\":\"claude\",\"name\":\"Lead\",\"role\":\"orchestrator\",\"prompt\":\"Coordinate.\"},{\"agent_type\":\"claude\",\"name\":\"Dev\",\"prompt\":\"Build.\"},{\"agent_type\":\"claude\",\"name\":\"QA\",\"prompt\":\"Test.\"}]}")
BOARD=$(echo "$launch" | python3 -c "import sys,json; print(json.load(sys.stdin).get('board_id',''))" 2>/dev/null)
[[ -n "$BOARD" ]] || { log "ERROR: no board_id from the launch: $launch"; exit 1; }
sleep 6
log "BEFORE Kill All: live list (id, name, board, state):"; live | sed 's/^/    /'
BEFORE_IDS="$(live | awk -F'\t' -v b="$BOARD" '$3 == b {print $1}')"
[[ $(echo "$BEFORE_IDS" | grep -c .) == 3 ]] || { log "ERROR: expected 3 team agents"; exit 1; }
WS_BEFORE="$(grep -c 'pty spawn failed\|already exists' "$TMP/server.log")"

SCENARIO="${CORAL_TEST_SCENARIO:-killall}"
if [[ "$SCENARIO" == exited ]]; then
    # The agents' own processes end (each is a mock-agent started under the server, found by its PID below it): Kill All is not used, so the dead terminals stay in the terminal manager.
    log "THE AGENTS EXIT ON THEIR OWN: stopping each mock-agent process of this run by its PID"
    for p in $(descendants "$SERVER_PID"); do
        if ps -o command= -p "$p" 2>/dev/null | grep -q "$TMP/mock-agent"; then kill "$p" 2>/dev/null && echo "    stopped mock-agent pid $p"; fi
    done
    sleep 20 # Coral notices a gone terminal on its next pass
else
    log "KILL ALL (POST /api/sessions/live/team/<board>/kill)"
    api POST "/api/sessions/live/team/${BOARD}/kill" | sed 's/^/    answer: /'; echo
    sleep 3
fi
log "AFTER the agents ended: live list for the team:"; live | awk -F'\t' -v b="$BOARD" '$3 == b' | sed 's/^/    /'; echo "    (rows: $(live | awk -F'\t' -v b="$BOARD" '$3 == b' | wc -l | tr -d ' '))"

log "WAKE TEAM (POST /api/sessions/live/team/<board>/wake)"
wake=$(api POST "/api/sessions/live/team/${BOARD}/wake"); echo "    answer: $wake"
sleep 4
log "AFTER Wake Team: live list for the team:"; live | awk -F'\t' -v b="$BOARD" '$3 == b' | sed 's/^/    /'
log "server log lines about spawn failures since the launch:"
grep -n 'pty spawn failed\|already exists\|Failed to wake' "$TMP/server.log" | sed 's/^/    /' | tail -8
echo "    (matching lines: $(grep -c 'pty spawn failed\|already exists' "$TMP/server.log"), before Kill All: $WS_BEFORE)"

if [[ "$SCENARIO" == killall ]]; then
    # Confirm of Wake Team's offer: every member the wake answer listed as ended is resumed in turn, through History's two calls (resume-info, then launch with resume_session_id on the team's board), as the dashboard does.
    log "CONFIRM THE RESUME OF EVERY ENDED MEMBER THE WAKE ANSWER LISTED"
    echo "$wake" | python3 -c '
import json, sys
for e in (json.load(sys.stdin).get("ended") or []): print(e["session_id"], e["name"], sep="\t")' > "$TMP/ended.tsv"
    echo "    listed: $(cut -f2 "$TMP/ended.tsv" | paste -sd, -)"
    while IFS=$'\t' read -r esid ename; do
        einfo=$(api GET "/api/sessions/history/${esid}/resume-info")
        ewd=$(echo "$einfo" | python3 -c "import sys,json; print(json.load(sys.stdin).get('working_dir',''))" 2>/dev/null)
        erid=$(echo "$einfo" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('resume_session_id') or '$esid')" 2>/dev/null)
        ename2=$(echo "$einfo" | python3 -c "import sys,json; print(json.load(sys.stdin).get('display_name') or '$ename')" 2>/dev/null)
        eres=$(api POST "/api/sessions/launch" -d "{\"working_dir\":\"$ewd\",\"agent_type\":\"claude\",\"resume_session_id\":\"$erid\",\"display_name\":\"$ename2\",\"board_id\":\"$BOARD\",\"board_name\":\"$BOARD\",\"backend\":\"$CORAL_TEST_BACKEND\"}")
        echo "    $ename: resume-info working_dir=$ewd; launch ok=$(echo "$eres" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))" 2>/dev/null)"
    done < "$TMP/ended.tsv"
    sleep 4
    log "AFTER CONFIRM: live list for the team (expect Lead, Dev and QA awake):"; live | awk -F'\t' -v b="$BOARD" '$3 == b' | sed 's/^/    /'
    back=$(live | awk -F'\t' -v b="$BOARD" '$3 == b && $4 == "awake" {print $2}' | sort | paste -sd, -)
    log "RESULT: awake in the team after Confirm: $back"
    log "server log: any spawn failure after the resume: $(grep -c 'pty spawn failed\|already exists' "$TMP/server.log")"
fi
log "INBOX RESTART of one ended member (the dashboard's resume: resume-info, then launch on the team's board)"
SID=$(echo "$BEFORE_IDS" | head -1)
info=$(api GET "/api/sessions/history/${SID}/resume-info"); echo "    resume-info: $info" | cut -c1-300
wd=$(echo "$info" | python3 -c "import sys,json; print(json.load(sys.stdin).get('working_dir',''))" 2>/dev/null)
rid=$(echo "$info" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('resume_session_id') or '$SID')" 2>/dev/null)
if [[ -n "$wd" ]]; then
    res=$(api POST "/api/sessions/launch" -d "{\"working_dir\":\"$wd\",\"agent_type\":\"claude\",\"resume_session_id\":\"$rid\",\"display_name\":\"Dev\",\"board_id\":\"$BOARD\",\"board_name\":\"$BOARD\",\"backend\":\"$CORAL_TEST_BACKEND\"}")
    echo "    launch (resume): $res" | cut -c1-300
    sleep 3
    log "AFTER the inbox Restart: live list for the team:"; live | awk -F'\t' -v b="$BOARD" '$3 == b' | sed 's/^/    /'
else
    log "no working_dir in resume-info: the dashboard would say it cannot resume from there"
fi
log "done"
