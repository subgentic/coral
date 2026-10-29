#!/usr/bin/env bash
#
# Agent search (#11005), end to end on a real, isolated Coral in STRICT mode, with real stand-in agents
# (cmd/mock-agent) using their real session tokens and the real coral-board CLI. Phase (a): board search at
# the 'own' reach. Every team and the Operator's board carries a CANARY string, and every phase asserts that
# only the caller's own team's canary comes back:
#   own        an agent finds a phrase from an old post on its own board; paging walks every match once; read --id
#              gives the context; another team's message id gives nothing
#   doors      a seat the Operator makes on a foreign board does not widen it; two boards with one label are told
#              apart by key; the Operator's board is never in the results
#   identity   no token, a wrong token, a token-less agent shell and another session's id are refused, no data
#   reach      --team, --all and --operator-history are refused: 403 with the words for the Operator, exit 5
#   restart    an agent restarted and an agent woken in the middle of a loop of searches: no other team's canary in
#              any answer; the old token is refused and the new one searches
#   log        100 back-to-back searches grow the server log by a bounded amount and the log holds no canary
#   levels     (#11048) the 4x4 matrix: every level (own, team, all, operator), set by the Operator's route, against
#              every flag (none, --team, --all, --operator-history), for the board search and the chat history
#              search: allowed exactly when the flag is not above the level, else exit 5 naming the level needed and
#              no data; each allowed reach returns the right canaries (team: its own team's only; all: every team's
#              board but not the Operator's own; operator: that board too)
#   identity   (levels) an agent token calling the set route or reading the access log is refused; a teammate at
#              'own' does not borrow another's level; setting 'operator' needs confirm; the access log has the raises
#              and the reads above own and no text; a loop of refused requests reaches the rate limit (429)
#
# Usage:  tests/stress/run_search.sh      (or: tests/stress/run.sh --search)
#   CORAL_SEARCH_PORT (default 8477), KEEP_TEST_DATA=1
# Never touches ~/.coral or ports 8420/8450; the server runs with --cloud-url off and is stopped by PID.
#
set -euo pipefail
export CORAL_TELEMETRY_DISABLED=1
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/agent_env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/backend.sh"
NP() { coral_test_native_path "$1"; }
EXE="$CORAL_TEST_EXE"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORAL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/coral-go"
PORT="${CORAL_SEARCH_PORT:-8477}"
if [[ "$PORT" == 8420 || "$PORT" == 8450 ]]; then echo "ERROR: refusing port $PORT (a live Coral server's port); pick another port." >&2; exit 2; fi
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0; SERVER_PID=""
TMP="$(mktemp -d /tmp/csr.XXXXXX)"
export TMPDIR="$TMP"
DATA="$TMP/d"; DUMP="$TMP/dump"; BIN="$TMP/bin"
mkdir -p "$DATA" "$DUMP" "$BIN" "$TMP/h" "$TMP/w"
log()  { echo "[search] $*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }
own_mock_pids() { ps -eo pid=,args= | awk -v b="$BIN/mock-agent" '$2 == b {print $1}'; }
cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
    for sock in "$DATA"/tmux.sock "$DATA"/*.sock; do [[ -S "$sock" ]] && tmux -S "$sock" kill-server 2>/dev/null || true; done
    local pid; for pid in $(own_mock_pids); do kill "$pid" 2>/dev/null || true; done
    if [[ $code -ne 0 || $FAIL -gt 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then log "Test data and server log kept: $TMP"; else rm -rf "$TMP" 2>/dev/null || { sleep 2; rm -rf "$TMP" 2>/dev/null || true; }; fi
    coral_test_sandbox_cleanup
    exit "$code"
}
trap cleanup EXIT
JAR="$TMP/jar"; COOKIE_ARGS=""
api() { local m="$1" p="$2"; shift 2; curl -s -m 20 $COOKIE_ARGS -X "$m" "$BASE$p" -H "Content-Type: application/json" "$@"; }
wait_until() { local limit=$1 what=$2; shift 2; local end=$((SECONDS + limit)); while ! "$@"; do if (( SECONDS >= end )); then fail "timed out waiting for $what"; return 1; fi; sleep 0.5; done; }
token_of() { sed -n 's/^CORAL_SESSION_TOKEN=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
sess_of() { sed -n 's/^CORAL_SESSION_NAME=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
role_of() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('job_title',''))" "$(NP "$DATA/board_state_$(sess_of "$1").json")" 2>/dev/null || true; }
live_json() { api GET /api/sessions/live | python3 -c 'import sys,json
d=json.load(sys.stdin); d=d.get("sessions",d) if isinstance(d,dict) else d
print(json.dumps(d))'; }
# '<session_id>' of the first live agent whose board LABEL is $1 and whose display name is $2
agent_of() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if str(s.get("board_label",""))==sys.argv[1] and (s.get("display_name") or "")==sys.argv[2]: print(s["session_id"]); break' "$1" "$2"; }
board_key_of() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if str(s.get("board_label",""))==sys.argv[1]: print(s["board_project"]); break' "$1"; }
# the real coral-board, from an agent's own environment: as_agent <session_id> <coral-board args...>
as_agent() {
    local sid=$1; shift
    env -i PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" \
        CORAL_SESSION_TOKEN="$(token_of "$sid")" CORAL_SESSION_NAME="$(sess_of "$sid")" CORAL_SUBSCRIBER_ID="$(role_of "$sid")" "$BIN/coral-board" "$@" 2>&1
}
operator_post() { api POST "/api/board/$1/messages" -d "$(python3 -c 'import json,sys; print(json.dumps({"subscriber_id":"Operator","content":sys.argv[1]}))' "$2")" >/dev/null; }

log "Building coral, coral-board and the stand-in agent..."
(cd "$CORAL_DIR" && go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-stop 2>/dev/null \
    || go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state) && (cd "$CORAL_DIR" && go build -o "$BIN/mock-agent$EXE" ./cmd/mock-agent/)
log "Starting an isolated STRICT server on $PORT (data $DATA)..."
coral_test_sandbox
env -u CORAL_CLOUD_URL -u CLAUDE_PROJECTS_DIR HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TMUX_NO_FALLBACK=1 MOCK_AGENT_CORAL_BOARD="$BIN/coral-board" MOCK_AGENT_ENV_DUMP="$(NP "$DUMP")" \
    "$BIN/coral" --home "$(NP "$DATA")" --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" --strict-local-auth >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
wait_until 30 "the server" curl -fsS -m 2 "$BASE/api/health" -o /dev/null || exit 1
signin=""
for _ in $(seq 1 30); do   # the command-line token file appears a moment after the server answers its health check
    signin=$(env -u DISPLAY "$BIN/coral" open --print --url "$BASE" --home "$(NP "$DATA")" 2>/dev/null | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1 || true)
    [[ -n "$signin" ]] && break
    sleep 1
done
[[ -n "$signin" ]] && curl -s -m 10 -c "$JAR" -o /dev/null "$signin"
grep -q coral_session "$JAR" 2>/dev/null && COOKIE_ARGS="-b $JAR" || { fail "could not sign in"; exit 1; }
api PUT /api/settings -d "{\"cli_path_claude\": \"$(NP "$BIN/mock-agent$EXE")\"}" >/dev/null

# ── Setup: three teams of two, the Operator's board, two boards with one label ──────────────────────────
for t in 1 2 3; do
    api POST /api/sessions/launch-team -d "{\"board_name\":\"srch-team-$t\",\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[
        {\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Lead.\"},{\"agent_type\":\"claude\",\"name\":\"Dev $t\",\"prompt\":\"Dev.\"}]}" >/dev/null
done
for t in 1 2; do
    api POST /api/sessions/launch-team -d "{\"board_name\":\"srch-twin\",\"new_board\":true,\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[{\"agent_type\":\"claude\",\"name\":\"Twin $t\",\"prompt\":\"x\"}]}" >/dev/null
done
wait_until 90 "the agents to start" bash -c "[[ \$(ls '$DUMP'/*.env 2>/dev/null | wc -l) -ge 8 ]]" || exit 1
sleep 3
K1=$(board_key_of srch-team-1); K2=$(board_key_of srch-team-2); K3=$(board_key_of srch-team-3)
OPS=$(api POST /api/board/srch-ops/subscribe -d '{"subscriber_id":"Operator","job_title":"Operator"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("project",""))' 2>/dev/null || true); OPS=${OPS:-srch-ops}
TWINS=$(live_json | python3 -c 'import sys,json
print(" ".join(sorted({s["board_project"] for s in json.load(sys.stdin) if str(s.get("board_label",""))=="srch-twin"})))')
read -r T1 T2 <<<"$TWINS"
CAN1="CANARY-one-$RANDOM$RANDOM"; CAN2="CANARY-two-$RANDOM$RANDOM"; CAN3="CANARY-three-$RANDOM$RANDOM"; CANOPS="CANARY-ops-$RANDOM$RANDOM"; CANT1="CANARY-twin1-$RANDOM$RANDOM"; CANT2="CANARY-twin2-$RANDOM$RANDOM"
operator_post "$K1" "$CAN1 the old decision about the release train"
operator_post "$K2" "$CAN2 the old decision about the release train"
operator_post "$K3" "$CAN3 the old decision about the release train"
operator_post "$OPS" "$CANOPS the old decision about the release train"
operator_post "$T1" "$CANT1 the old decision about the release train"
operator_post "$T2" "$CANT2 the old decision about the release train"
for i in $(seq 1 25); do operator_post "$K1" "PAGEWORD number $i on team one"; done
[[ -n "$K1" && -n "$K2" && -n "$K3" && -n "$T1" && -n "$T2" ]] || { fail "setup: boards $K1 $K2 $K3 $T1 $T2"; exit 1; }
S1=$(agent_of srch-team-1 Orchestrator); S2=$(agent_of srch-team-2 Orchestrator)
sessions_on() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s.get("board_project")==sys.argv[1]: print(s["session_id"])' "$1"; }
ST1=$(sessions_on "$T1" | head -1)   # an agent of the twin board T1, so its canary is CANT1 (which of the two boards is first is arbitrary)
wait_until 40 "the agents' dumps" bash -c "grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$S1.env' 2>/dev/null && grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$ST1.env' 2>/dev/null" || exit 1
ALLCAN="$CAN2 $CAN3 $CANOPS $CANT1 $CANT2"
no_foreign() { local text=$1 c; shift; for c in "$@"; do [[ "$text" == *"$c"* ]] && return 1; done; return 0; } # none of the given canaries in the text

# ── own: finds an old phrase, pages, context ───────────────────────────────────────────────────────────
out=$(as_agent "$S1" search "old decision" ) || true
if [[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN; then pass "own: an agent finds the old post on its own board, and no other team's or the Operator's canary"; else fail "own: search answered: ${out:0:300}"; fi
out=$(as_agent "$S1" search "CANARY") || true
if [[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN; then pass "own: a search for every canary returns only its own team's"; else fail "own: CANARY search: ${out:0:300}"; fi
seen=0; cursor=""; dupes=0; : > "$TMP/seen_ids"
for page in 1 2 3 4 5 6 7 8; do
    if [[ -n "$cursor" ]]; then out=$(as_agent "$S1" search "PAGEWORD" --limit 5 --sort oldest --cursor "$cursor") || true; else out=$(as_agent "$S1" search "PAGEWORD" --limit 5 --sort oldest) || true; fi
    ids=$(grep -o '^  #[0-9]*' <<<"$out" | tr -d ' #' || true)
    for id in $ids; do grep -qx "$id" "$TMP/seen_ids" && dupes=$((dupes + 1)); echo "$id" >> "$TMP/seen_ids"; done
    cursor=$(sed -n 's/^More: .*--cursor \(.*\)$/\1/p' <<<"$out" | head -1)
    [[ -z "$cursor" ]] && break
done
seen=$(sort -u "$TMP/seen_ids" | grep -c . || true)
[[ $seen -eq 25 && $dupes -eq 0 ]] && pass "own: paging with --limit 5 walks all 25 matches once each" || fail "own: paging saw $seen ids with $dupes repeats"
first=$(sort -n "$TMP/seen_ids" | head -1)
out=$(as_agent "$S1" read --id "$first") || true
[[ "$out" == *"PAGEWORD"* ]] && pass "own: read --id gives a hit's message" || fail "own: read --id $first: ${out:0:200}"
# another team's message id: not readable by this agent
other_id=$(api GET "/api/board/$K2/messages/all" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("messages",d)[0]["id"])' 2>/dev/null || true)
out=$(as_agent "$S1" read --id "$other_id") && rc=0 || rc=$?
no_foreign "$out" $ALLCAN && [[ $rc -ne 0 || "$out" != *"$CAN2"* ]] && pass "own: read --id of another team's message id gives none of it" || fail "own: read --id $other_id leaked: ${out:0:200}"

# ── doors: a foreign seat, two boards with one label ────────────────────────────────────────────────────
api POST "/api/board/$K2/subscribe" -d "{\"subscriber_id\":\"Seated Guest\",\"job_title\":\"Guest\",\"session_name\":\"$(sess_of "$S1")\"}" >/dev/null
out=$(as_agent "$S1" search "CANARY") || true
if [[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN; then pass "doors: a seat the Operator made on team 2's board does not widen the search"; else fail "doors: after a foreign seat: ${out:0:300}"; fi
out=$(as_agent "$ST1" search "CANARY") || true
if [[ "$out" == *"$CANT1"* ]] && no_foreign "$out" $CAN1 $CAN2 $CAN3 $CANOPS $CANT2; then pass "doors: of two boards with one label the agent searches its own by key"; else fail "doors: twin search: ${out:0:300}"; fi
out=$(as_agent "$S1" search "CANARY" --from Operator) || true
no_foreign "$out" $ALLCAN && pass "doors: a --from filter cannot reach another board" || fail "doors: --from: ${out:0:200}"

# ── identity: no token, wrong token, token-less shell, another session ─────────────────────────────────
c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY"); [[ $c == 401 ]] && pass "identity: no token is 401" || fail "identity: no token answered $c"
c=$(curl -s -m 10 -o "$TMP/wrong.out" -w "%{http_code}" -H "X-Coral-Session-Token: not-a-token" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY"); [[ $c == 401 ]] && ! grep -q CANARY "$TMP/wrong.out" && pass "identity: a wrong token is 401 and returns nothing" || fail "identity: wrong token answered $c"
out=$(env -i PATH="$PATH" HOME="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" CORAL_SESSION_NAME="$(sess_of "$S1")" CORAL_SUBSCRIBER_ID="$(role_of "$S1")" "$BIN/coral-board" search CANARY 2>&1) && rc=0 || rc=$?
[[ $rc -ne 0 ]] && no_foreign "$out" $CAN1 $ALLCAN && pass "identity: an agent shell with its token removed gets nothing (exit $rc)" || fail "identity: token-less shell rc=$rc: ${out:0:200}"
tok1=$(token_of "$S1")
c=$(curl -s -m 10 -o "$TMP/other.out" -w "%{http_code}" -H "X-Coral-Session-Token: $tok1" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY&session_id=$ST1")
[[ $c == 403 ]] && ! grep -q "$CANT1" "$TMP/other.out" && pass "identity: a token asking as another session is refused (403)" || fail "identity: another session's id answered $c"

# ── reach: refused with the words for the Operator, exit 5 ───────────────────────────────────────────────
for flag in --team --all --operator-history; do
    out=$(as_agent "$S1" search CANARY "$flag") && rc=0 || rc=$?
    if [[ $rc -eq 5 && "$out" == *"Refused: this agent's search access is 'own'"* ]] && no_foreign "$out" $CAN1 $ALLCAN; then pass "reach: $flag is refused, exit 5, the Operator's words, no data"; else fail "reach: $flag rc=$rc: ${out:0:240}"; fi
done

# ── restart and wake in the middle of a loop of searches ─────────────────────────────────────────────────
: > "$TMP/loop.out"
( for i in $(seq 1 16); do as_agent "$S1" search CANARY >> "$TMP/loop.out" 2>&1 || true; sleep 0.4; done ) &
LOOP=$!
sleep 1
ENVS_BEFORE=$(ls "$DUMP"/*.env 2>/dev/null | tr '\n' ' ')
nm1=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s["name"])' "$S1")
api POST "/api/sessions/live/$nm1/restart" -d "{\"session_id\":\"$S1\",\"agent_type\":\"claude\"}" >/dev/null
wait "$LOOP" || true
no_foreign "$(cat "$TMP/loop.out")" $ALLCAN && pass "restart: no other team's canary in any of 16 answers while the agent restarted" || fail "restart: a foreign canary appeared mid-loop"
grep -q "$CAN1" "$TMP/loop.out" && pass "restart: searches before the restart succeeded" || fail "restart: no answer carried its own canary"
NS1=""; end=$((SECONDS + 60))
while (( SECONDS < end )); do
    NS1=""
    for f in "$DUMP"/*.env; do   # the restart's new session writes a new environment dump (only this agent was restarted in the window)
        [[ " $ENVS_BEFORE " != *" $f "* ]] && grep -q '^CORAL_SESSION_TOKEN=' "$f" 2>/dev/null && NS1=$(basename "$f" .env)
    done
    [[ -n "$NS1" ]] && break
    sleep 1
done
c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $tok1" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY")
[[ $c == 401 ]] && pass "restart: the old token is refused (401)" || fail "restart: the old token answered $c"
if [[ -n "$NS1" ]]; then
    out=$(as_agent "$NS1" search CANARY) || true
    [[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN && pass "restart: the restarted agent searches its own board with its new token" || fail "restart: new token search: ${out:0:240}"
    api POST "/api/sessions/live/$NS1/sleep" -d '{}' >/dev/null; sleep 2
    api POST "/api/sessions/live/$NS1/wake" -d '{}' >/dev/null
    wk=""; oldk=$(token_of "$NS1"); end=$((SECONDS + 60))
    while (( SECONDS < end )); do wk=$(token_of "$NS1"); [[ -n "$wk" && "$wk" != "$oldk" ]] && break; sleep 1; done
    out=$(as_agent "$NS1" search CANARY) || true
    [[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN && pass "wake: the woken agent searches its own board with its new token, no foreign canary" || fail "wake: search after wake: ${out:0:240}"
else fail "restart: the restarted agent never came back"; NS1="$S1"; fi

# ── levels (#11048): the 4x4 matrix, set by the Operator's route ───────────────────────────────────────────
as_agent_cli() {
    local sid=$1; shift
    env -i PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" \
        CORAL_SESSION_TOKEN="$(token_of "$sid")" CORAL_SESSION_NAME="$(sess_of "$sid")" CORAL_SUBSCRIBER_ID="$(role_of "$sid")" "$BIN/coral-agent" "$@" 2>&1
}
# the id of the team member row a session is on (members[].id of the team detail), looking under each name given
member_of() {
    local sid=$1 n; shift
    for n in "$@"; do
        api GET "/api/teams/detail/$n" | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for m in d.get("members") or []:
    if m.get("session_id")==sys.argv[1]: print(m["id"]); break' "$sid" | head -1 | grep . && return 0
    done
    return 1
}
set_level() { api PUT "/api/team-members/$1/search-access" -d "{\"level\":\"$2\"$( [[ $2 == operator ]] && echo ',"confirm":"operator"' )}"; }
rank() { case "$1" in own|"") echo 0;; team) echo 1;; all) echo 2;; operator) echo 3;; esac; }
LV_SID="${NS1:-$S1}"
LV_MEMBER=$(member_of "$LV_SID" "$K1" srch-team-1 || true)
DEV1=$(agent_of srch-team-1 "Dev 1"); DEV1_MEMBER=$(member_of "$DEV1" "$K1" srch-team-1 || true)
if [[ -z "$LV_MEMBER" || -z "$DEV1_MEMBER" ]]; then fail "levels: no team member row for the agents ($LV_MEMBER / $DEV1_MEMBER)"; else
    out=$(api GET "/api/teams/detail/$K1" || true)
    [[ "$out" == *'"search_reach":"own"'* ]] && pass "levels: every member row starts at 'own'" || fail "levels: team detail has no search_reach: ${out:0:200}"
    # the new SET route: the Operator's, a bad level is 400, 'operator' needs confirm, an unknown member is 404
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" $COOKIE_ARGS -X PUT "$BASE/api/team-members/$LV_MEMBER/search-access" -H "Content-Type: application/json" -d '{"level":"operator"}'); [[ $c == 400 ]] && pass "levels: 'operator' without the confirm is 400" || fail "levels: operator without confirm answered $c"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" $COOKIE_ARGS -X PUT "$BASE/api/team-members/$LV_MEMBER/search-access" -H "Content-Type: application/json" -d '{"level":"root"}'); [[ $c == 400 ]] && pass "levels: an unknown level is 400" || fail "levels: root answered $c"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" $COOKIE_ARGS -X PUT "$BASE/api/team-members/99999999/search-access" -H "Content-Type: application/json" -d '{"level":"team"}'); [[ $c == 404 ]] && pass "levels: a member id that is not there is 404" || fail "levels: unknown member answered $c"
    bad=0
    for level in own team all operator; do
        out=$(set_level "$LV_MEMBER" "$level"); [[ "$out" == *'"ok":true'* ]] || { fail "levels: could not set $level: ${out:0:160}"; bad=1; continue; }
        for flag in none --team --all --operator-history; do
            want=$(rank "$level"); case "$flag" in none) need=0;; --team) need=1;; --all) need=2;; --operator-history) need=3;; esac
            fa=(); [[ $flag != none ]] && fa=("$flag")
            # the board search
            out=$(as_agent "$LV_SID" search CANARY ${fa[@]+"${fa[@]}"}) && rc=0 || rc=$?
            if (( need <= want )); then
                if (( need == 3 )); then okc=$([[ "$out" == *"$CAN1"* && "$out" == *"$CAN2"* && "$out" == *"$CAN3"* && "$out" == *"$CANOPS"* ]] && echo y || echo n)   # operator: every team's board and the boards no team owns
                elif (( need == 2 )); then okc=$([[ "$out" == *"$CAN1"* && "$out" == *"$CAN2"* && "$out" == *"$CAN3"* && "$out" != *"$CANOPS"* ]] && echo y || echo n)   # all: the boards of teams Coral launched, not the Operator's own
                else okc=$([[ "$out" == *"$CAN1"* ]] && no_foreign "$out" $ALLCAN && echo y || echo n); fi
                [[ $rc -eq 0 && $okc == y ]] || { fail "levels: board search at $level with $flag: rc=$rc ${out:0:200}"; bad=1; }
            else
                [[ $rc -eq 5 && "$out" == *"search access is '$level'"* ]] && no_foreign "$out" $CAN1 $ALLCAN || { fail "levels: board search at $level with $flag should be refused (exit 5, no data): rc=$rc ${out:0:200}"; bad=1; }
            fi
            # the chat history search (the stand-in agents have no transcripts: the check is the door, not the text)
            out=$(as_agent_cli "$LV_SID" history search zebra ${fa[@]+"${fa[@]}"}) && rc=0 || rc=$?
            if (( need <= want )); then [[ $rc -eq 0 ]] || { fail "levels: history search at $level with $flag: rc=$rc ${out:0:200}"; bad=1; }
            else [[ $rc -eq 5 && "$out" == *"search access is '$level'"* ]] || { fail "levels: history search at $level with $flag should be refused (exit 5): rc=$rc ${out:0:200}"; bad=1; }; fi
        done
    done
    (( bad == 0 )) && pass "levels: the 4x4 matrix (own, team, all, operator x none, --team, --all, --operator-history) for the board search and the history search"
    # a teammate at 'own' does not borrow the level of the agent beside it
    set_level "$LV_MEMBER" all >/dev/null
    out=$(as_agent "$DEV1" search CANARY --all) && rc=0 || rc=$?
    [[ $rc -eq 5 ]] && no_foreign "$out" $CAN1 $ALLCAN && pass "levels: a teammate at 'own' does not borrow another agent's 'all'" || fail "levels: teammate borrowed a level: rc=$rc ${out:0:200}"
    # an agent token cannot raise a level, its own or anyone's, nor read the log
    tokL=$(token_of "$LV_SID")
    for m in "$LV_MEMBER" "$DEV1_MEMBER"; do
        c=$(curl -s -m 10 -o "$TMP/esc.out" -w "%{http_code}" -X PUT -H "X-Coral-Session-Token: $tokL" -H "Content-Type: application/json" -A "coral-board/test" "$BASE/api/team-members/$m/search-access" -d '{"level":"all","confirm":"operator"}')
        [[ $c == 403 ]] && pass "identity: an agent token cannot set member $m's level (403)" || fail "identity: agent token set member $m: $c $(head -c 120 "$TMP/esc.out")"
    done
    got=$(api GET "/api/teams/detail/$K1" | python3 -c 'import sys,json
d=json.load(sys.stdin)
print(",".join(m["agent_name"]+"="+m["search_reach"] for m in d.get("members") or []))')
    [[ "$got" == *"=all"* && "$got" == *"=own"* ]] && pass "identity: after the refused escalations the levels are the Operator's ($got)" || fail "identity: levels now $got"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $tokL" -A "coral-board/test" "$BASE/api/search-access/log"); [[ $c == 403 ]] && pass "identity: an agent token cannot read the access log (403)" || fail "identity: agent read the log: $c"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -X PUT -H "Content-Type: application/json" -A "coral-board/test" "$BASE/api/team-members/$LV_MEMBER/search-access" -d '{"level":"all"}'); [[ $c == 401 || $c == 403 ]] && pass "identity: no token and no sign-in cannot set a level ($c)" || fail "identity: anonymous set answered $c"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -X PUT -H "X-Coral-Session-Token: not-a-token" -H "Content-Type: application/json" -A "coral-board/test" "$BASE/api/team-members/$LV_MEMBER/search-access" -d '{"level":"all"}'); [[ $c == 401 || $c == 403 ]] && pass "identity: a wrong token cannot set a level ($c)" || fail "identity: wrong-token set answered $c"
    # the access log: the raises and the reads above own, no text
    out=$(api GET "/api/search-access/log?limit=1000")
    python3 - "$out" <<'PY' && pass "levels: the access log has the raises and the reads above own, with no query or result text" || fail "levels: access log: ${out:0:300}"
import sys, json
rows = json.loads(sys.argv[1])["rows"]
kinds = {r["kind"] for r in rows}
assert {"raise", "read"} <= kinds, kinds
text = json.dumps(rows)
assert "CANARY" not in text and "zebra" not in text and "old decision" not in text
assert any(r["outcome"] == "refused" for r in rows if r["kind"] == "read")
PY
    # a finished job's board (#11076): a job's agent uses a board through the API (that marks the board), the run is killed (its live row is gone), and no level reads the board, the Operator's own included
    JOBC="CANARY-finishedjob-$RANDOM$RANDOM"
    JB=$(api POST /api/board/srch-jobboard/subscribe -d '{"subscriber_id":"Operator","job_title":"Operator"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("project",""))' 2>/dev/null || true)
    operator_post "${JB:-srch-jobboard}" "$JOBC the old decision"
    jresp=$(api POST /api/scheduled/jobs -d "{\"name\":\"srch-job\",\"cron_expr\":\"0 3 * * *\",\"repo_path\":\"$(NP "$TMP/w")\",\"agent_type\":\"claude\",\"prompt\":\"x\",\"enabled\":0,\"no_worktree\":1}")
    jid=$(python3 -c 'import sys,json; print(json.loads(sys.argv[1]).get("id",""))' "$jresp" 2>/dev/null || true)
    jsid=""
    if [[ -n "$jid" && -n "$JB" ]]; then
        api POST "/api/scheduled/jobs/$jid/run" -d '{}' >/dev/null
        end=$((SECONDS + 60))
        while (( SECONDS < end )); do
            jsid=$(api GET "/api/scheduled/jobs/$jid/runs" | python3 -c 'import sys,json
d=json.load(sys.stdin); runs=d.get("runs",d) if isinstance(d,dict) else d
print((runs[0].get("session_id") or "") if runs else "")' 2>/dev/null || true)
            [[ -n "$jsid" ]] && grep -q '^CORAL_SESSION_TOKEN=' "$DUMP/$jsid.env" 2>/dev/null && break
            sleep 1
        done
    fi
    if [[ -n "$jsid" ]] && grep -q '^CORAL_SESSION_TOKEN=' "$DUMP/$jsid.env" 2>/dev/null; then
        api POST "/api/board/$JB/subscribe" -d "{\"subscriber_id\":\"Job Agent\",\"job_title\":\"Job\",\"session_name\":\"$(sess_of "$jsid")\"}" >/dev/null
        c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $(token_of "$jsid")" -H "Content-Type: application/json" -A "coral-board/test" -X POST "$BASE/api/board/$JB/messages" -d '{"subscriber_id":"Job Agent","content":"job note"}')
        jn=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s["name"])' "$jsid")
        [[ -n "$jn" ]] && api POST "/api/sessions/live/$jn/kill" -d '{}' >/dev/null
        sleep 2
        set_level "$LV_MEMBER" operator >/dev/null
        out=$(as_agent "$LV_SID" search CANARY --operator-history) || true
        if [[ "$c" == 200 && "$out" == *"$CANOPS"* && "$out" != *"$JOBC"* ]]; then pass "levels: a finished job's board (marked when the job used it) is not read at 'operator', where the Operator's own board is"; else fail "levels: finished job's board: post=$c ${out:0:300}"; fi
        set_level "$LV_MEMBER" own >/dev/null
    else fail "levels: the job's agent never started (job $jid, session $jsid, created: ${jresp:0:200})"; fi
    # a restart keeps the level, and a loop of refused requests reaches the rate limit (refusals count)
    set_level "$DEV1_MEMBER" own >/dev/null
    c429=0
    for i in $(seq 1 45); do
        c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $(token_of "$DEV1")" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY&reach=all")
        [[ $c == 429 ]] && c429=$((c429 + 1))
    done
    (( c429 > 0 )) && pass "levels: a loop of refused requests reaches the rate limit (429 on $c429 of 45)" || fail "levels: 45 refused requests never answered 429"
    c=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $(token_of "$DEV1")" -A "coral-board/test" "$BASE/api/agent/board/search?q=CANARY"); [[ $c == 200 ]] && pass "levels: a read at 'own' is not limited" || fail "levels: own read after the limit answered $c"
    set_level "$LV_MEMBER" own >/dev/null
fi

# ── log bounds: bounded growth, no message text ──────────────────────────────────────────────────────────
before=$(wc -c < "$TMP/server.log" | tr -d ' ')
for i in $(seq 1 100); do as_agent "${NS1:-$S1}" search CANARY >/dev/null || true; done
after=$(wc -c < "$TMP/server.log" | tr -d ' ')
per=$(( (after - before) / 100 ))
(( per <= 400 )) && pass "log: 100 back-to-back searches grew the server log by $per bytes each (bound 400)" || fail "log: $per bytes of server log per search"
if grep -q -e "$CAN1" -e "$CAN2" -e "$CAN3" -e "$CANOPS" "$TMP/server.log"; then fail "log: a canary string is in the server log"; else pass "log: no canary string (message text) in the server log"; fi

log "Done: $PASS passed, $FAIL failed"
coral_test_sandbox_check || FAIL=$((FAIL + 1))
[[ $FAIL -eq 0 ]]
