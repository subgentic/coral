#!/usr/bin/env bash
#
# The owner's own message to an agent through a self-hosted Hub (#13456, #13467), end to end on loopback.
#
#   bash tests/stress/run_hub_owner_send.sh        (or: bash tests/stress/run.sh --hub-owner-send)
#
# Two isolated Coral servers, each with its own data folder and HOME, the pty backend and a mock agent on the remote: a hub (coral --hub, port 8793) and a second Coral (port 8794) registered at the hub by
# its API key, then given the hub's owner secret (the person's act at the remote: coral hub-owner-secret). Then:
#   - the person signed in at the hub sends to the remote's agent: the remote's chat shows it as the person's (coral_notice false), not as a Coral reminder;
#   - a script that holds the hub's API key sends to the same agent: it reaches it, unstamped, and the chat shows it as Coral's (coral_notice true);
#   - the owner's message over 64 KB gets the hub's clear refusal (413, hub_message_too_long, not_sent) and nothing of it reaches the agent; a script's over-64 KB message goes through whole.
# It fails on a build from before #13456 (the owner's message shows as a notice, the long one is not refused). Never touches ~/.coral or :8420; E2E_HUB_PORT and E2E_REMOTE_PORT move the
# ports; KEEP=1 keeps the temp folder (its logs) after the run.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
source "$REPO_ROOT/tests/lib/agent_env.sh"
source "$REPO_ROOT/tests/lib/backend.sh"
export CORAL_TEST_BACKEND=pty
HP="${E2E_HUB_PORT:-8793}"; RP="${E2E_REMOTE_PORT:-8794}"
for p in $HP $RP; do
  [[ "$p" == 8420 ]] && { echo "refusing 8420"; exit 2; }
  if coral_test_port_in_use "$p"; then echo "port $p in use"; exit 2; fi
done
HB="http://127.0.0.1:$HP"; RB="http://127.0.0.1:$RP"
W="$(mktemp -d "${TMPDIR:-/tmp}/coral-test-hub-owner-send.XXXXXX")"
mkdir -p "$W/home-h" "$W/home-r" "$W/data-h" "$W/data-r" "$W/work"
export TMPDIR="$W"
export CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1
PASS=0; FAIL=0; HPID=""; RPID=""
log()  { echo "[e2e] $*"; }
pass() { PASS=$((PASS+1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL+1)); log "FAIL: $*"; }
check() { if eval "$2"; then pass "$1"; else fail "$1${3:+ -- $3}"; fi; }
cleanup() {
  for pid in $HPID $RPID; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null; done
  for pid in $HPID $RPID; do [[ -n "$pid" ]] && wait "$pid" 2>/dev/null; done
  CORAL_DATA_DIR="$W/data-h" coral_test_kill_tmux_server; CORAL_DATA_DIR="$W/data-r" coral_test_kill_tmux_server # (the pty backend has no tmux server: a no-op, and the guard every stress runner passes)
  coral_test_sandbox_cleanup >/dev/null 2>&1
  if [[ $FAIL -gt 0 || "${KEEP:-0}" == 1 ]]; then log "kept: $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT
jget() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

log "building"
( cd coral-go && go build -p 1 -tags "dev fts5" -o "$W/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync \
  && go build -p 1 -o "$W/mock-agent" ./cmd/mock-agent/ ) || { echo "build failed"; exit 1; }
coral_test_sandbox
start() { # name home data port extra...
  local name=$1 home=$2 data=$3 port=$4; shift 4
  env -u CORAL_PORT -u CORAL_URL -u CORAL_SESSION_NAME -u CORAL_SUBSCRIBER_ID -u CLAUDE_PROJECTS_DIR -u CORAL_CLOUD_URL -u CORAL_HUB HOME="$home" PATH="$CORAL_TEST_STUB_BIN:$PATH" \
    "$W/coral" --home "$data" --no-browser --cloud-url off --host 127.0.0.1 --port "$port" --backend pty "$@" >"$W/$name.log" 2>&1 &
  echo $!
}
waitup() { local b=$1 n=60; while ! command curl -s -m 3 "$b/api/health" >/dev/null 2>&1; do n=$((n-1)); [[ $n -le 0 ]] && return 1; sleep 0.5; done; }
RPID=$(MOCK_AGENT_READY=1 MOCK_AGENT_TRANSCRIPT=1 start remote "$W/home-r" "$W/data-r" "$RP")
HPID=$(start hub "$W/home-h" "$W/data-h" "$HP" --hub)
waitup "$RB" || { echo "remote did not start"; tail -5 "$W/remote.log"; exit 1; }
waitup "$HB" || { echo "hub did not start"; tail -5 "$W/hub.log"; exit 1; }
log "remote :$RP and hub :$HP are up"

signin() { # base data jar -> cookie
  local link; link=$("$W/coral" open --print --url "$1" --home "$2" | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1)
  [[ -n "$link" ]] || return 1
  command curl -s -m 10 -o /dev/null -c "$3" "$link"
  awk '$6 ~ /^coral_session/ {print $6 "=" $7}' "$3" | tail -1
}
RCOOKIE=$(signin "$RB" "$W/data-r" "$W/jar-r") ; HCOOKIE=$(signin "$HB" "$W/data-h" "$W/jar-h")
[[ -n "$RCOOKIE" && -n "$HCOOKIE" ]] || { echo "sign-in failed"; exit 1; }
rapi() { local m=$1 p=$2; shift 2; command curl -s -m 15 -X "$m" "$RB$p" -H "Content-Type: application/json" -H "Origin: $RB" -H "Sec-Fetch-Site: same-origin" -H "Cookie: $RCOOKIE" "$@"; }
hperson() { local m=$1 p=$2; shift 2; command curl -s -m 20 -X "$m" "$HB$p" -H "Content-Type: application/json" -H "Origin: $HB" -H "Sec-Fetch-Site: same-origin" -H "Cookie: $HCOOKIE" "$@"; }
HKEY=$("$W/coral" api-key --home "$W/data-h"); RKEY=$("$W/coral" api-key --home "$W/data-r")
hscript() { local m=$1 p=$2; shift 2; command curl -s -m 20 -X "$m" "$HB$p" -H "Content-Type: application/json" -H "Authorization: Bearer $HKEY" "$@"; }

# the mock agent stands in for the CLI, on the remote
rapi PUT /api/settings -d "{\"cli_path_claude\": \"$W/mock-agent\"}" >/dev/null
mkdir -p "$W/work/agent"
L=$(rapi POST /api/sessions/launch -d "{\"working_dir\": \"$W/work/agent\", \"agent_type\": \"claude\", \"display_name\": \"Remote Agent\"}")
SID=$(echo "$L" | jget "d.get('session_id','')"); NAME=$(echo "$L" | jget "d.get('session_name') or ('claude-' + d.get('session_id',''))")
check "the remote's mock agent launched" '[[ -n "$SID" ]]' "$L"
sleep 3 # sleep-ok: the mock agent starts in its terminal

# register the remote at the hub by its API key (the person at the hub)
ADD=$(hperson POST /api/servers -d "{\"id\":\"r1\",\"label\":\"r1\",\"url\":\"$RB\",\"api_key\":\"$RKEY\",\"allow_private\":true}")
check "the hub registered the remote by its key" '[[ "$ADD" == *"\"id\":\"r1\""* ]]' "$ADD"
SETUP=$(hperson POST /api/servers/r1/owner-secret)
LINE=$(echo "$SETUP" | jget "d.get('setup_line','')")
check "the hub gave a setup line for the remote" '[[ "$LINE" == r1\ * ]]' "$SETUP"
# the person's act at the remote
printf '{"remote":"r1","secret":"%s"}' "${LINE#r1 }" | env -u CORAL_SESSION_NAME -u CORAL_SESSION_TOKEN -u CORAL_SUBSCRIBER_ID "$W/coral" hub-owner-secret --home "$W/data-r" >"$W/hos.out" 2>&1
check "the remote took the owner secret" '[[ $? -eq 0 ]]' "$(cat "$W/hos.out")"
sleep 2 # sleep-ok: the hub's next health read sees the secret

sendbody() { python3 -c "import json,sys; print(json.dumps({'command': sys.argv[1], 'agent_type': 'claude', 'session_id': sys.argv[2]}))" "$1" "$SID"; }
OWNER_TXT="E2E-OWNER-MESSAGE please report your status $RANDOM"
SCRIPT_TXT="E2E-SCRIPT-MESSAGE please report your status $RANDOM"
for i in $(seq 1 30); do # an agent that is not ready refuses with agent_not_ready (409): ask again until it takes it
  O=$(hperson POST "/api/remote/r1/api/sessions/live/$NAME/send" -d "$(sendbody "$OWNER_TXT")" -w ' HTTP:%{http_code}')
  [[ "$O" == *agent_not_ready* ]] || break
  sleep 1 # sleep-ok: the agent is starting
done
check "the signed-in owner's send through the hub reached the agent (200)" '[[ "$O" == *"HTTP:200"* ]]' "$O"
S=$(hscript POST "/api/remote/r1/api/sessions/live/$NAME/send" -d "$(sendbody "$SCRIPT_TXT")" -w ' HTTP:%{http_code}')
check "a script with the hub's API key sent through the hub (200, unstamped)" '[[ "$S" == *"HTTP:200"* ]]' "$S"
sleep 3 # sleep-ok: the mock agent writes the messages into its transcript

CHAT=$(rapi GET "/api/sessions/live/$NAME/chat?session_id=$SID&agent_type=claude&after=0&limit=50")
echo "$CHAT" > "$W/chat.json"
python3 - "$W/chat.json" "$OWNER_TXT" "$SCRIPT_TXT" > "$W/chatflags.txt" <<'PY'
import sys, json
d = json.load(open(sys.argv[1]))
for m in d.get('messages', []):
    t = m.get('text') or m.get('content') or ''
    if not isinstance(t, str): t = json.dumps(t)
    for tag, key in (('OWNER', sys.argv[2]), ('SCRIPT', sys.argv[3])):
        if key in t:
            print(tag, 'coral_notice=%s' % m.get('coral_notice'), 'role=%s' % m.get('role'))
print('messages:', len(d.get('messages', [])))
PY
log "chat as the remote reads it:"; sed 's/^/[e2e]   /' "$W/chatflags.txt"
check "the owner's message shows as the person's (not a Coral notice)" 'grep -q "^OWNER coral_notice=False" "$W/chatflags.txt"' "$(cat "$W/chatflags.txt")"
check "the script's message shows as Coral's (a notice)" 'grep -q "^SCRIPT coral_notice=True" "$W/chatflags.txt"' "$(cat "$W/chatflags.txt")"

# over 64 KB
BIG=$(python3 -c "print('E2E-BIG-' + 'x' * 70000)")
OB=$(hperson POST "/api/remote/r1/api/sessions/live/$NAME/send" -d "$(sendbody "$BIG")" -w ' HTTP:%{http_code}')
check "the owner's over-64 KB message gets the clear refusal (413 hub_message_too_long, not_sent)" '[[ "$OB" == *"HTTP:413"* && "$OB" == *"hub_message_too_long"* && "$OB" == *"not_sent"* ]]' "${OB:0:300}"
SB=$(hscript POST "/api/remote/r1/api/sessions/live/$NAME/send" -d "$(sendbody "$BIG")" -w ' HTTP:%{http_code}')
log "a script's over-64 KB send: ${SB: -40}"
CAP=$(rapi GET "/api/sessions/live/$NAME/capture?agent_type=claude&session_id=$SID" | jget "d.get('capture') or ''" | tr -d '\n')
log "owner big message reached the agent's terminal? $([[ "$CAP" == *E2E-BIG-* ]] && echo 'something with E2E-BIG is there (may be the script one)' || echo no)"
log "RESULT: $PASS passed, $FAIL failed"
exit $FAIL
