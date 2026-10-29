#!/usr/bin/env bash
#
# Identity phase 1 (#3387), end to end on a real, isolated Coral with real agents (a
# stand-in CLI, cmd/mock-agent, that posts through the real coral-board like an agent's
# tool call). Checks:
#   tokens   every launch (incl. 3 team launches x 4 agents), restart and wake mints a
#            token; each agent's environment has CORAL_SESSION_TOKEN; unique; a restart or
#            wake changes it and the old one stops matching
#   leaks    no token in argv (ps), the server log, any file in the data folder (terminal
#            logs, databases), the board, or the tmux server's global environment
#   attribution  coral-board calls from inside agents are attributed to their session with
#            no mismatch, and the agent itself never touches the token
#   impersonation  an agent's token used to post as another subscriber, as Operator, or on
#            another board is detected (counted and logged; phase 1 never refuses)
#   login    the startup sign-in link and `coral open`: single use, cookie exchange
#            (HttpOnly, SameSite=Strict), token stripped by the redirect, reuse refused
#   scale    3 teams x 4 agents plus 2 restart rounds of all 12, within IDENTITY_BUDGET_S
#
# Without --strict the server runs with --strict-local-auth=false: strict local auth is Coral's default since
# #3936, so that mode now checks the opt-out (agents' tokens still attributed, impersonation detected).
# With --strict (or IDENTITY_STRICT=1) the server runs with --strict-local-auth (phase 2, #3418) and the same
# team run must work end to end with ZERO refusals, while impersonation, cross-board, untokened and
# dashboard-without-cookie calls are refused (403 identity_mismatch, 401 session_token_required,
# 401 dashboard_auth_required), the CLI-signed Operator path outside agents works, an agent-marked shell with
# no token never becomes Operator, and the app sign-in path (page load -> /auth -> coral open link) lands on
# the dashboard.
#
# Usage:  tests/stress/run_identity.sh [--strict]   (or: tests/stress/run.sh --identity [--strict])
#   CORAL_IDENTITY_PORT (default 8476), IDENTITY_BUDGET_S (default 240), KEEP_TEST_DATA=1
# Never touches ~/.coral or port 8420; the server runs with CORAL_CLOUD_URL unset and
# --cloud-url off; it and its tmux server are stopped by PID / their own socket.
#
set -euo pipefail
export CORAL_TELEMETRY_DISABLED=1 # our own runs send no usage events (#4936)
STRICT=0
[[ "${1:-}" == "--strict" || "${IDENTITY_STRICT:-0}" == 1 ]] && STRICT=1
# Clears an agent shell's identity and production links (and documents: never run bare 'tmux' here).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/agent_env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/backend.sh"
# Both backends (#191): the token checks read each agent's own environment from the stand-in's dump, which works the
# same on tmux and on the PTY backend (Windows). Only the two looks into tmux's global environment are tmux's own; on
# the PTY backend there is no shared terminal server holding an environment, so they are skipped, saying so.
NP() { coral_test_native_path "$1"; }   # a path as a Windows program sees it (unchanged elsewhere)
EXE="$CORAL_TEST_EXE"
# process_cmdlines: every process's command line, for the no-token-in-argv check (Git Bash's ps has no -o).
process_cmdlines() {
    if coral_test_is_windows; then
        powershell -NoProfile -Command 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }' 2>/dev/null
    else
        ps -axo command
    fi
}
# own_mock_pids: this run's stand-ins, by their exact program path, never a pattern.
own_mock_pids() {
    if coral_test_is_windows; then
        local exe; exe="$(cygpath -w "$BIN/mock-agent$EXE")"
        powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='mock-agent.exe'\" | Where-Object { \$_.ExecutablePath -eq '$exe' } | ForEach-Object { \$_.ProcessId }" 2>/dev/null | tr -d '\r'
    else
        ps -eo pid=,args= | awk -v b="$BIN/mock-agent" '$2 == b {print $1}'
    fi
}
# Windows' Python ends its lines with CRLF: a session id read from it would keep the CR and name no dump file. Strip it,
# keeping python's own exit status (some checks below are its sys.exit).
if coral_test_is_windows; then
    python3() { command python3 "$@" | tr -d '\r'; return "${PIPESTATUS[0]}"; }
fi
stop_pid() {
    if coral_test_is_windows; then powershell -NoProfile -Command "Stop-Process -Id $1 -Force -ErrorAction SilentlyContinue" 2>/dev/null; else kill "$1" 2>/dev/null; fi
}
# env -i drops SystemRoot on Windows, and a Go program then can't open a socket: keep the variables Windows itself needs.
WIN_ENV=()
coral_test_is_windows && WIN_ENV=(SystemRoot="${SYSTEMROOT:-${SystemRoot:-C:\Windows}}" WINDIR="${WINDIR:-C:\Windows}")

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORAL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/coral-go"
PORT="${CORAL_IDENTITY_PORT:-8476}"
if [[ "$PORT" == 8420 || "$PORT" == 8450 ]]; then echo "ERROR: refusing port $PORT (a live Coral server's port: 8420 production, 8450 the team's); pick another port." >&2; exit 2; fi
BUDGET_S="${IDENTITY_BUDGET_S:-240}"
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0; SERVER_PID=""
# A short folder: the tmux socket path must stay under the 104-byte limit (macOS).
TMP="$(mktemp -d /tmp/cid.XXXXXX)"
export TMPDIR="$TMP"  # server os.TempDir() droppings land here, removed on exit (#3926)
DATA="$TMP/d"; DUMP="$TMP/dump"; BIN="$TMP/bin"
mkdir -p "$DATA" "$DUMP" "$BIN" "$TMP/h" "$TMP/w"

log()  { echo "[identity] $*"; }
pass() { PASS=$((PASS + 1)); log "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); log "FAIL: $*"; }

cleanup() {
    local code=$?
    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    for sock in "$DATA"/tmux.sock "$DATA"/*.sock; do
        [[ -S "$sock" ]] && tmux -S "$sock" kill-server 2>/dev/null || true
    done
    # Stand-ins still running (a timed-out run, #3827): only processes whose program is this run's
    # own mock-agent, by exact path and PID, never a pattern.
    local pid
    for pid in $(own_mock_pids); do
        stop_pid "$pid" || true
    done
    if [[ $code -ne 0 || $FAIL -gt 0 || ${KEEP_TEST_DATA:-0} == 1 ]]; then
        log "Test data and server log kept: $TMP"
    else
        # A stand-in or tmux still shutting down can write into the folder while it is removed
        # ('Directory not empty'): try again once, and never let it change the run's result.
        rm -rf "$TMP" 2>/dev/null || { sleep 2; rm -rf "$TMP" 2>/dev/null || true; }
    fi
    coral_test_sandbox_cleanup   # #4354
    exit "$code"
}
trap cleanup EXIT

# Strict mode refuses a dashboard-style request without the session cookie: the harness signs in once (below)
# and every call of its own carries the cookie jar. COOKIE_ARGS is empty in phase 1.
JAR="$TMP/jar"; COOKIE_ARGS=""
api() { local m="$1" p="$2"; shift 2; curl -s -m 15 $COOKIE_ARGS -X "$m" "$BASE$p" -H "Content-Type: application/json" "$@"; }
# The identity report is for the dashboard on this computer: send what its page sends.
report() { curl -s -m 10 $COOKIE_ARGS -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" "$BASE/api/system/identity-report"; }
rjson() { report | python3 -c "import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
dumps() { ls "$DUMP"/*.env 2>/dev/null | wc -l | tr -d ' '; }
tokens() { cat "$DUMP"/*.env 2>/dev/null | sed -n 's/^CORAL_SESSION_TOKEN=//p'; }
wait_until() { # wait_until <seconds> <description> <command...>
    local limit=$1 what=$2; shift 2
    local end=$((SECONDS + limit))
    while ! "$@"; do
        if (( SECONDS >= end )); then fail "timed out waiting for $what"; return 1; fi
        sleep 0.5
    done
}
ALL_TOKENS="$TMP/all_tokens"; : > "$ALL_TOKENS"
collect() { tokens >> "$ALL_TOKENS"; sort -u -o "$ALL_TOKENS" "$ALL_TOKENS"; }
# Live team agents (not the blind team): '<name> <session_id>' per line.
sessions() { api GET /api/sessions/live | python3 -c '
import sys,json
d=json.load(sys.stdin); d=d.get("sessions",d) if isinstance(d,dict) else d
for s in d:
    if str(s.get("board_label") or s.get("board_project","")).startswith("id-team-"): print(s["name"], s["session_id"])'; }
# Live team agents whose stand-in has already written its environment dump (with its token): a
# just-restarted, woken or resumed agent has a new session id before its dump exists, and reading a
# missing dump aborted the run (set -e). The stand-in writes the dump asynchronously, so wait for it.
sessions_ready() { local n sid; while read -r n sid; do [[ -n "$sid" ]] && grep -q '^CORAL_SESSION_TOKEN=' "$DUMP/$sid.env" 2>/dev/null && echo "$n $sid"; done < <(sessions); }
wait_sessions_ready() { local end=$((SECONDS + 30)); while [[ -z "$(sessions_ready | head -1)" ]]; do (( SECONDS >= end )) && return 1; sleep 0.5; done; }

log "Building coral, coral-board and the stand-in agent..."
# This build's coral-board and coral-hook-* next to coral: a dev or test server never uses the
# installed app's (#3492), so without them its agents would send no status events.
(cd "$CORAL_DIR" && go build -tags "dev fts5" -o "$BIN/" ./cmd/coral ./cmd/coral-board ./cmd/coral-agent ./cmd/coral-hook-agentic-state ./cmd/coral-hook-session-start ./cmd/coral-hook-message-check ./cmd/coral-hook-task-sync \
    && go build -o "$BIN/mock-agent$EXE" ./cmd/mock-agent/)

log "Starting an isolated server on $PORT (data $DATA)..."
# #3421: the server is started from a HOSTILE parent environment, like a test server started
# from an agent's shell: another Coral's port, URL, data folder and an agent identity and
# token. None of it may reach this server's agents (checked below).
HOSTILE_ENV=(CORAL_PORT=1 CORAL_HOST=10.255.255.1 CORAL_URL=http://10.255.255.1:1 CORAL_DIR=/nonexistent/parent-coral
    CORAL_DATA_DIR=/nonexistent/parent-coral CORAL_SESSION_NAME=parent-session-3421 CORAL_SESSION_ID=parent-sid-3421
    CORAL_SUBSCRIBER_ID=ParentRole3421 CORAL_SESSION_TOKEN=leak-token-parent-3421
    # The same names in lower and mixed case: Windows reads environment names without regard to case, so these are the
    # same variables to an agent there, and a filter that strips only CORAL_* would let them through.
    coral_session_token=leak-token-lower-3421 Coral_Dir=/nonexistent/parent-mixed-coral coral_session_name=parent-lower-session-3421)
coral_test_sandbox   # #4354: stub claude/codex/gemini first on PATH; checked at the end
env -u CORAL_CLOUD_URL -u CLAUDE_PROJECTS_DIR HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" PATH="$CORAL_TEST_STUB_BIN:$PATH" "${HOSTILE_ENV[@]}" \
    CORAL_NO_DEMO_SEED=1 CORAL_NO_WELCOME=1 CORAL_TMUX_NO_FALLBACK=1 \
    MOCK_AGENT_CORAL_BOARD="$BIN/coral-board" MOCK_AGENT_ENV_DUMP="$(NP "$DUMP")" MOCK_AGENT_BLIND_PREFIX=id-blind \
    CORAL_TEST_LOGIN_TOKEN_TTL=3s \
    "$BIN/coral" --home "$(NP "$DATA")" --no-browser --cloud-url off --host 127.0.0.1 --port "$PORT" --backend "$CORAL_TEST_BACKEND" \
    $([[ $STRICT == 1 ]] && echo --strict-local-auth || echo --strict-local-auth=false) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
wait_until 30 "the server" curl -fsS -m 2 "$BASE/api/health" -o /dev/null || exit 1
coral_open() { env -u DISPLAY "$BIN/coral" open --print --url "$BASE" --home "$(NP "$DATA")" | sed -n 's/^ *\(http[^ ]*login_token=[^ ]*\).*/\1/p' | head -1; }
if [[ $STRICT == 1 ]]; then
    log "STRICT: signing the harness in with a 'coral open' link, then every call carries the cookie"
    signin=$(coral_open)
    [[ -n "$signin" ]] && curl -s -m 10 -c "$JAR" -o /dev/null "$signin"
    grep -q coral_session "$JAR" 2>/dev/null && COOKIE_ARGS="-b $JAR" || { fail "could not sign in with a coral open link"; exit 1; }
fi
api PUT /api/settings -d "{\"cli_path_claude\": \"$(NP "$BIN/mock-agent$EXE")\"}" >/dev/null

# ── Dashboard sign-in links ───────────────────────────────────────────
check_link() { # check_link <link> <label>
    local hdr="$TMP/hdr" code loc
    code=$(curl -s -m 10 -o /dev/null -D "$hdr" -w "%{http_code}" "$1")
    loc=$(sed -n 's/^[Ll]ocation: //p' "$hdr" | tr -d '\r')
    if [[ $code == 302 ]] && grep -qi "^set-cookie: coral_session_[0-9a-f]*=.*HttpOnly.*SameSite=Strict" "$hdr" && [[ $loc != *login_token* ]]; then
        pass "$2: one use gives the session cookie (HttpOnly, SameSite=Strict) and a redirect without the token"
    else
        fail "$2: code=$code location=$loc"
    fi
    code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$1")
    [[ $code == 403 ]] && pass "$2: a second use is refused" || fail "$2: reuse answered $code"
}
# Capture the startup token before it is used: the server removes the login_token file after the
# token is consumed (#3628 F7 / #3743), so a later read of the file would fail.
STARTUP_TOKEN="$(tr -d '\n' < "$DATA/login_token")"
check_link "$BASE/?login_token=$STARTUP_TOKEN" "startup link"
open_link=$(coral_open)
[[ -n "$open_link" ]] && check_link "$open_link" "coral open" || fail "coral open printed no link"
# Expiry (this dev build runs with CORAL_TEST_LOGIN_TOKEN_TTL=3s; the real TTL is 10 min).
late_link=$(coral_open); sleep 4
code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$late_link")
[[ $code == 403 ]] && pass "an expired sign-in link is refused" || fail "expired link answered $code"
LOGIN_TOKENS="$STARTUP_TOKEN ${open_link##*=} ${late_link##*=}"

# ── Scale: 3 teams x 4 agents ─────────────────────────────────────────
STARTED=$SECONDS
for t in 1 2 3; do
    out=$(api POST /api/sessions/launch-team -d "{\"board_name\":\"id-team-$t\",\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[
        {\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Lead.\"},
        {\"agent_type\":\"claude\",\"name\":\"Dev $t\",\"prompt\":\"Dev.\"},
        {\"agent_type\":\"claude\",\"name\":\"QA $t\",\"prompt\":\"QA.\"},
        {\"agent_type\":\"claude\",\"name\":\"Ops $t\",\"prompt\":\"Ops.\"}]}")
    echo "$out" | grep -q '"session' || fail "team $t launch: $out"
done
# A 4th, "blind" team: its stand-ins never read the token (like a real agent).
out=$(api POST /api/sessions/launch-team -d "{\"board_name\":\"id-blind-1\",\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[
    {\"agent_type\":\"claude\",\"name\":\"Orchestrator\",\"prompt\":\"Lead.\"},{\"agent_type\":\"claude\",\"name\":\"Blind Dev\",\"prompt\":\"Dev.\"},
    {\"agent_type\":\"claude\",\"name\":\"Blind QA\",\"prompt\":\"QA.\"},{\"agent_type\":\"claude\",\"name\":\"Blind Ops\",\"prompt\":\"Ops.\"}]}")
echo "$out" | grep -q '"session' || fail "blind team launch: $out"
wait_until 90 "12 agents to start" bash -c "[[ \$(ls '$DUMP'/*.env 2>/dev/null | wc -l) -ge 12 && \$(ls '$DUMP'/*.blind 2>/dev/null | wc -l) -ge 4 ]]" || true
collect
n=$(tokens | grep -c . || true); u=$(tokens | sort -u | grep -c . || true)
short=$(tokens | awk 'length($0) < 40' | grep -c . || true)
[[ $n -ge 12 && $n -eq $u && $short -eq 0 ]] && pass "12 team agents each got their own token ($u unique, none short)" || fail "tokens after team launch: $n total, $u unique, $short short"

# ── Attribution: coral-board from inside the agents ───────────────────
wait_until 60 "the agents' coral-board posts to be attributed" bash -c "[[ \$(curl -s $COOKIE_ARGS -H 'Origin: $BASE' -H 'Sec-Fetch-Site: same-origin' $BASE/api/system/identity-report | python3 -c 'import sys,json;print(json.load(sys.stdin)[\"callers\"].get(\"agent_token\",0))') -ge 12 ]]" || true
attributed=$(rjson 'd["callers"].get("agent_token",0)')
mism=$(rjson 'sum(d["mismatches"].values())')
[[ $attributed -ge 12 && $mism -eq 0 ]] && pass "coral-board calls from the agents are attributed ($attributed) with no mismatch" || fail "attribution: agent_token=$attributed mismatches=$mism"

# ── No agent action: the agents never handle the token ────────────────
blind_ok=1
wait_until 60 "the blind agents' coral-board posts" bash -c "for f in '$DUMP'/*.blind; do n=\$(head -1 \"\$f\"); curl -s $COOKIE_ARGS -H 'Origin: $BASE' -H 'Sec-Fetch-Site: same-origin' $BASE/api/system/identity-report | python3 -c \"import sys,json;sys.exit(0 if json.load(sys.stdin)['attributed_by_session'].get('\$n',0)>0 else 1)\" || exit 1; done" || blind_ok=0
[[ $blind_ok == 1 && $(rjson 'sum(d["mismatches"].values())') == 0 ]] && pass "4 'blind' agents that never read the token are attributed through coral-board alone, no mismatch" || fail "blind agents not all attributed"
tools=$(rjson 'd["attributed_by_tool"]')
[[ $tools == *coral-board* && $tools != *mock-agent* ]] && pass "only Coral's tools sent the token: $tools" || fail "attributed tools: $tools"
handed_bad=0
for f in "$DUMP"/*.handed; do
    grep -qiE "SESSION_TOKEN|session_tokens" "$f" && { fail "the prompt or settings Coral handed $(basename "$f") mention the token"; handed_bad=1; }
    while read -r tok; do [[ -n "$tok" ]] && grep -qF -- "$tok" "$f" && { fail "a token value in what Coral handed $(basename "$f")"; handed_bad=1; }; done < <(tokens)
done
[[ $handed_bad == 0 ]] && pass "no prompt or settings handed to the $(ls "$DUMP"/*.handed | wc -l | tr -d ' ') agents mentions the token or its file"
[[ -z "$(ls -A "$DATA/session_tokens" 2>/dev/null)" ]] && pass "every token file was read and deleted by the shell before the agent CLI started" || fail "token files left: $(ls "$DATA/session_tokens")"

# ── A hook from inside an agent carries the token ─────────────────────
wait_sessions_ready || log "no live agent has its dump yet"
read -r hname hsid < <(sessions_ready | head -1)
htok=$(sed -n 's/^CORAL_SESSION_TOKEN=//p' "$DUMP/$hsid.env"); hsess=$(sed -n 's/^CORAL_SESSION_NAME=//p' "$DUMP/$hsid.env")
# The agent's own board state (written when it joined) names its board and role.
hstate="$DATA/board_state_$hsess.json"
wait_until 30 "the agent's board state ($hsess)" test -s "$hstate" || true
hsub=$(python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('subscriber_id') or d.get('job_title',''))" "$(NP "$hstate")" 2>/dev/null || true)
[[ -n "$hsub" ]] || log "hook check: no subscriber in $hstate"
before=$(rjson 'd["attributed_by_tool"].get("coral-hook-message-check",0)')
hook_out=$(echo '{}' | env -u CORAL_URL CORAL_SESSION_TOKEN="$htok" CORAL_SESSION_NAME="$hsess" CORAL_SUBSCRIBER_ID="$hsub" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" "$BIN/coral-hook-message-check" 2>&1 || true)
after=$(rjson 'd["attributed_by_tool"].get("coral-hook-message-check",0)')
[[ $after -gt $before ]] || log "hook check: session=$hsess sub=$hsub output=$hook_out"
[[ $after -gt $before ]] && pass "coral-hook-message-check sends the token from its environment and is attributed" || fail "hook not attributed ($before -> $after)"

# Strict mode: everything above was a normal team run with the harness signed in, so NOTHING was refused.
EXP_TOKEN=0; EXP_MISMATCH=0; EXP_DASH=0; EXP_AGENT_OP=0   # refusals the probes below cause on purpose
if [[ $STRICT == 1 ]]; then
    [[ "$(rjson 'd.get("mode")')" == strict ]] && pass "the identity report says mode strict" || fail "report mode: $(rjson 'd.get("mode")')"
    [[ "$(rjson 'json.dumps(d.get("refused",{}))')" == "{}" ]] && pass "STRICT: a healthy team run (12 agents, attribution, a hook, blind agents) had zero refusals" || fail "STRICT: refusals in a healthy run: $(rjson 'json.dumps(d.get("refused",{}))')"
fi

# ── Restart rounds: new tokens, old ones stop matching ────────────────
OLD=$(tokens | head -1)
for round in 1 2; do
    before=$(dumps)
    while read -r name sid; do
        api POST "/api/sessions/live/$name/restart" -d "{\"session_id\":\"$sid\",\"agent_type\":\"claude\"}" >/dev/null
    done < <(sessions)
    wait_until 90 "round $round restarts" bash -c "[[ \$(ls '$DUMP' | wc -l) -ge $((before + 12)) ]]" || true
    collect
done
# Each stand-in writes its dump asynchronously: give the last ones a moment, then count.
union36() { collect; [[ $(grep -c . "$ALL_TOKENS" || true) -ge 36 ]]; }
# 60 s: on the PTY backend (Windows) the 24 restarts take ~1.8 s each and a restarted stand-in can write its dump after a
# 30 s wait (seen once: 35 of 36, no token reused); only a late dump spends the extra time.
wait_until 60 "all 36 tokens to be reported by their agents" union36 || true
ELAPSED=$((SECONDS - STARTED))
total=$(grep -c . "$ALL_TOKENS" || true)
[[ $total -ge 36 ]] && pass "restarts minted new tokens: $total unique across 3 rounds of 12, no collision" || fail "only $total unique tokens after 2 restart rounds (want 36)"
(( ELAPSED <= BUDGET_S )) && pass "12 agents + 24 restarts in ${ELAPSED}s (budget ${BUDGET_S}s)" || fail "too slow: ${ELAPSED}s > ${BUDGET_S}s"
bad_before=$(rjson 'd["callers"].get("agent_bad_token",0)')
oldcode=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $OLD" -A "coral-board/test" "$BASE/api/board/id-team-1/messages/check?subscriber_id=x")
bad_after=$(rjson 'd["callers"].get("agent_bad_token",0)')
if [[ $STRICT == 1 ]]; then
    EXP_TOKEN=$((EXP_TOKEN + 1))
    [[ $oldcode == 401 ]] && pass "STRICT: a restarted agent's old token is refused (401)" || fail "STRICT: old token answered $oldcode"
else
    [[ $bad_after -eq $((bad_before + 1)) ]] && pass "a restarted agent's old token no longer matches" || fail "old token: bad_token $bad_before -> $bad_after"
fi

# ── Wake: sleep then wake mints a new token for the same session ──────
wait_sessions_ready || log "no live agent has its dump yet"
read -r wname wsid < <(sessions_ready | head -1)
wfile="$DUMP/$wsid.env"; before_tok=$(sed -n 's/^CORAL_SESSION_TOKEN=//p' "$wfile" 2>/dev/null || true)
api POST "/api/sessions/live/$wsid/sleep" -d '{}' >/dev/null; sleep 2
api POST "/api/sessions/live/$wsid/wake" -d '{}' >/dev/null
wait_until 60 "the woken agent's new token" bash -c "[[ -f '$wfile' && \$(sed -n 's/^CORAL_SESSION_TOKEN=//p' '$wfile') != '$before_tok' ]]" && pass "wake minted a new token for $wname" || true
collect

# ── Resume: a new token, the old one stops matching ───────────────────
wait_sessions_ready || log "no live agent has its dump yet"
read -r rname rsid < <(sessions_ready | tail -1)
rfile="$DUMP/$rsid.env"; rold=$(sed -n 's/^CORAL_SESSION_TOKEN=//p' "$rfile" 2>/dev/null || true)
api POST "/api/sessions/live/$rname/resume" -d "{\"session_id\":\"$rsid\",\"current_session_id\":\"$rsid\",\"agent_type\":\"claude\"}" >/dev/null
if wait_until 60 "the resumed agent's new token" bash -c "[[ -f '$rfile' && \$(sed -n 's/^CORAL_SESSION_TOKEN=//p' '$rfile') != '$rold' ]]"; then
    b0=$(rjson 'd["callers"].get("agent_bad_token",0)')
    rcode=$(curl -s -m 10 -o /dev/null -w "%{http_code}" -H "X-Coral-Session-Token: $rold" -A "coral-board/test" "$BASE/api/board/id-team-1/messages/check?subscriber_id=x")
    b1=$(rjson 'd["callers"].get("agent_bad_token",0)')
    if [[ $STRICT == 1 ]]; then
        EXP_TOKEN=$((EXP_TOKEN + 1))
        [[ $rcode == 401 ]] && pass "STRICT: resume minted a new token and the old one is refused (401)" || fail "STRICT: resume old token answered $rcode"
    else
        [[ $b1 -eq $((b0 + 1)) ]] && pass "resume minted a new token and the old one no longer matches" || fail "resume: old token still matched ($b0 -> $b1)"
    fi
fi
collect

# ── #3421: nothing from the parent's environment reaches an agent ────────
envdumps=$(ls "$DUMP"/*.coralenv 2>/dev/null | wc -l | tr -d ' ')
parent_leaks=$(cat "$DUMP"/*.coralenv 2>/dev/null | grep -cE 'parent-session-3421|parent-sid-3421|ParentRole3421|leak-token-parent-3421|/nonexistent/parent-coral|10\.255\.255\.1|^CORAL_PORT=1$' || true)
# The lower- and mixed-case names: on Windows they ARE the CORAL_* variables (names there ignore case), so none may reach an
# agent; elsewhere names are case-sensitive, they are other variables that no Coral tool reads, and they are only counted.
case_leaks=$(cat "$DUMP"/*.coralenv 2>/dev/null | grep -ciE 'leak-token-lower-3421|parent-mixed-coral|parent-lower-session-3421' || true)
if coral_test_is_windows; then
    parent_leaks=$((parent_leaks + case_leaks))
else
    log "case-sensitive environment: $case_leaks lower/mixed-case parent CORAL names reached agents as other variables (no Coral tool reads them)"
fi
wrong_port=$(cat "$DUMP"/*.coralenv 2>/dev/null | grep '^CORAL_PORT=' | grep -vc "^CORAL_PORT=$PORT$" || true)
tmux_parent=0
if [[ $CORAL_TEST_BACKEND == tmux ]]; then
    tmux_parent=$(tmux -S "$DATA/tmux.sock" show-environment -g 2>/dev/null | grep -cE 'parent-session-3421|ParentRole3421|leak-token-parent-3421|/nonexistent/parent-coral|10\.255\.255\.1' || true)
else
    log "PTY backend: no shared terminal server, so there is no global environment to check (tmux's show-environment -g)"
fi
if [[ $envdumps -ge 12 && $parent_leaks -eq 0 && $wrong_port -eq 0 && $tmux_parent -eq 0 ]]; then
    pass "a server started from a hostile parent env gives its $envdumps agents only its own CORAL_* (port $PORT, its data dir, their own identity)$([[ $CORAL_TEST_BACKEND == tmux ]] && echo "; the tmux server holds none of the parent's")"
else
    fail "parent env reached agents: dumps=$envdumps leaks=$parent_leaks wrong_port=$wrong_port tmux=$tmux_parent"
fi

# ── Leaks: the token is nowhere it shouldn't be ───────────────────────
leaks=0
pslist=$(process_cmdlines)
boards=$(for t in 1 2 3; do api GET "/api/board/id-team-$t/messages/all"; done)
globalenv=""
[[ $CORAL_TEST_BACKEND == tmux ]] && globalenv=$(for s in "$DATA"/tmux.sock "$DATA"/*.sock; do [[ -S "$s" ]] && tmux -S "$s" show-environment -g 2>/dev/null; done || true)
while read -r tok; do
    [[ -z "$tok" ]] && continue
    grep -qF -- "$tok" <<<"$pslist" && { fail "token in a process's argv"; leaks=1; }
    grep -qF -- "$tok" "$TMP/server.log" && { fail "token in the server log"; leaks=1; }
    grep -rqF -D skip -- "$tok" "$DATA" 2>/dev/null && { fail "token in a file in the data folder: $(grep -rlF -D skip -- "$tok" "$DATA" 2>/dev/null | head -1)"; leaks=1; }
    grep -qF -- "$tok" <<<"$boards" && { fail "token on the board"; leaks=1; }
done < "$ALL_TOKENS"
grep -q "CORAL_SESSION_TOKEN=" <<<"$globalenv" && { fail "CORAL_SESSION_TOKEN in the tmux server's global environment"; leaks=1; }
for lt in $LOGIN_TOKENS; do
    grep -qF -- "$lt" "$DATA/coral.log" 2>/dev/null && { fail "a sign-in token in coral.log"; leaks=1; }
done
[[ $leaks -eq 0 ]] && pass "no token in argv, the server log, the data folder (terminal logs, databases), the board$([[ $CORAL_TEST_BACKEND == tmux ]] && echo " or tmux's global env") ($(grep -c . "$ALL_TOKENS") tokens checked)"

# ── Impersonation is detected (phase 1: counted and logged, not refused) ──
wait_sessions_ready || log "no live agent has its dump yet"
read -r iname isid < <(sessions_ready | head -1)
itok=$(sed -n 's/^CORAL_SESSION_TOKEN=//p' "$DUMP/$isid.env")
iboard=$(api GET /api/sessions/live | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('sessions',d) if isinstance(d,dict) else d;print([s['board_project'] for s in d if s['session_id']=='$isid'][0])")
# Another team's board, by its id (#3536: boards have ids; their names are labels).
other=$(api GET /api/sessions/live | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('sessions',d) if isinstance(d,dict) else d;print(next(s['board_project'] for s in d if str(s.get('board_label') or '').startswith('id-team-') and s['board_project'] != '$iboard'))")
m0=$(rjson 'json.dumps(d["mismatches"])')
post_as() { curl -s -m 10 -o /dev/null -w "%{http_code}" -X POST "$BASE/api/board/$1/messages" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-board/test" -d "{\"subscriber_id\":\"$2\",\"content\":\"impersonation probe\"}"; }
c1=$(post_as "$iboard" "Somebody Else"); c2=$(post_as "$iboard" "Operator")
self=$(api GET /api/sessions/live | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('sessions',d) if isinstance(d,dict) else d;print([s.get('display_name') or s['name'] for s in d if s['session_id']=='$isid'][0])")
c3=$(post_as "$other" "$self")
mm=$(rjson 'd["mismatches"]')
if [[ $STRICT == 1 ]]; then
    EXP_MISMATCH=3
    [[ "$c1 $c2 $c3" == "403 403 403" ]] && pass "STRICT: impersonation, Operator and another board are each REFUSED (403: $c1 $c2 $c3)" || fail "STRICT: impersonation probes answered $c1 $c2 $c3 (want 403 403 403)"
fi
python3 - "$m0" "$(rjson 'json.dumps(d["mismatches"])')" <<'PY' && pass "impersonation, Operator and another board each detected once (requests $([[ $STRICT == 1 ]] && echo refused || echo not refused): $c1 $c2 $c3)" || fail "mismatch counts: before $m0 after $mm"
import sys, json
a, b = json.loads(sys.argv[1]), json.loads(sys.argv[2])
d = {k: b.get(k, 0) - a.get(k, 0) for k in ("impersonation", "operator", "cross_board")}
sys.exit(0 if d == {"impersonation": 1, "operator": 1, "cross_board": 1} else 1)
PY
grep -q "\[identity\] mismatch" "$TMP/server.log" && pass "the server log has the mismatch lines" || fail "no mismatch line in the server log"

# ── STRICT MODE (phase 2, #3418) ──────────────────────────────────────
if [[ $STRICT == 1 ]]; then
    code_of() { curl -s -m 10 -o /dev/null -w "%{http_code}" "$@"; }
    body_of() { curl -s -m 10 "$@"; }

    # The refusal body names its code.
    body=$(body_of -X POST "$BASE/api/board/$iboard/messages" $COOKIE_ARGS -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-board/test" -d '{"subscriber_id":"Somebody Else","content":"x"}')
    EXP_MISMATCH=4
    grep -q identity_mismatch <<<"$body" && pass "STRICT: the refusal says identity_mismatch" || fail "STRICT: refusal body: $body"

    # Untokened agent-tool call: refused, never served.
    c=$(code_of -A "coral-board/test" "$BASE/api/board/id-team-1/messages/check?subscriber_id=x"); EXP_TOKEN=$((EXP_TOKEN + 1))
    b=$(body_of -A "coral-board/test" "$BASE/api/board/id-team-1/messages/check?subscriber_id=x"); EXP_TOKEN=$((EXP_TOKEN + 1))
    [[ $c == 401 ]] && grep -q session_token_required <<<"$b" && pass "STRICT: an agent-tool call with no token is refused (401 session_token_required)" || fail "STRICT: untokened call answered $c $b"
    # ...and the real coral-board from an agent-marked shell whose token was removed: refused, never Operator.
    st0=$(rjson 'd.get("refused",{}).get("session_token_required",0)')
    out=$(env -i ${WIN_ENV[@]+"${WIN_ENV[@]}"} PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" CORAL_SESSION_NAME="stripped-agent" CORAL_SUBSCRIBER_ID="Operator" "$BIN/coral-board" post "stripped token probe" 2>&1) && rc=0 || rc=$?
    EXP_TOKEN=$((EXP_TOKEN + 1))
    st1=$(rjson 'd.get("refused",{}).get("session_token_required",0)')
    # The SERVER must have refused it (the counter moved), not merely coral-board failing for another reason.
    if [[ $rc -ne 0 && $st1 -gt $st0 ]] && ! api GET "/api/board/id-team-1/messages/all" | grep -q "stripped token probe"; then
        pass "STRICT: an agent-marked shell with its token removed gets nothing posted (never Operator): ${out:0:80}"
    else
        fail "STRICT: stripped-token post rc=$rc refused $st0 -> $st1 out=$out"
    fi

    # A human at a normal shell (no agent markers) signs with the CLI token and acts as the Operator.
    out=$(env -i ${WIN_ENV[@]+"${WIN_ENV[@]}"} PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" "$BIN/coral-board" join id-team-1 --as Operator 2>&1) && rc=0 || rc=$?
    if [[ $rc -eq 0 ]]; then
        out2=$(env -i ${WIN_ENV[@]+"${WIN_ENV[@]}"} PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" "$BIN/coral-board" post "operator from a plain shell" 2>&1) && rc2=0 || rc2=$?
        if [[ $rc2 -eq 0 ]] && api GET "/api/board/id-team-1/messages/all" | grep -q "operator from a plain shell"; then
            pass "STRICT: coral-board from a plain shell signs with the CLI token and posts as the Operator"
        else
            fail "STRICT: plain-shell post rc=$rc2 $out2"
        fi
    else
        fail "STRICT: plain-shell join as Operator failed: $out"
    fi

    # The dashboard without the session cookie.
    c=$(code_of "$BASE/api/sessions/live"); EXP_DASH=$((EXP_DASH + 1))
    b=$(body_of "$BASE/api/sessions/live"); EXP_DASH=$((EXP_DASH + 1))
    [[ $c == 401 ]] && grep -q dashboard_auth_required <<<"$b" && pass "STRICT: /api without the cookie: 401 dashboard_auth_required" || fail "STRICT: /api without a cookie answered $c"
    c=$(code_of -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" "$BASE/api/system/identity-report"); EXP_DASH=$((EXP_DASH + 1))
    [[ $c == 401 ]] && pass "STRICT: the identity report is cookie-gated too (401 without the cookie)" || fail "STRICT: report without cookie answered $c"
    c=$(code_of "$BASE/api/health"); [[ $c == 200 ]] && pass "STRICT: /api/health stays open" || fail "STRICT: health answered $c"
    c=$(code_of -X POST "$BASE/api/cloud/cli-hello" -H "Content-Type: application/json" -d '{"nonce":"x"}'); [[ $c != 401 ]] && pass "STRICT: the CLI hello stays open ($c)" || fail "STRICT: cli-hello answered 401"
    hdr="$TMP/hdr2"; c=$(curl -s -m 10 -o /dev/null -D "$hdr" -w "%{http_code}" "$BASE/"); loc=$(sed -n 's/^[Ll]ocation: //p' "$hdr" | tr -d '\r')
    [[ $c == 307 && $loc == *"/auth?locked=1"* ]] && pass "STRICT: a page load without the cookie goes to the locked /auth ($loc)" || fail "STRICT: / without a cookie: $c $loc"
    # /auth is the one sign-in page since #3948 (a password form, "Use an API key instead" behind a click), not a
    # separate locked page: in strict mode it is marked strict and never carries the API key itself.
    page=$(body_of "$BASE/auth?locked=1")
    apikey=""; [[ -s "$DATA/api_key" ]] && apikey=$(tr -d '\n' < "$DATA/api_key")
    if grep -q 'data-strict="true"' <<<"$page" && { [[ -z "$apikey" ]] || ! grep -qF -- "$apikey" <<<"$page"; }; then pass "STRICT: /auth is the sign-in page, marked strict, and does not show the API key"; else fail "STRICT: the /auth page: ${page:0:120}"; fi

    # The app/tray sign-in path: cookie-less page load -> /auth -> a fresh link from the CLI handshake -> the dashboard.
    link=$(coral_open); app_jar="$TMP/appjar"; rm -f "$app_jar"
    c=$(curl -s -m 10 -c "$app_jar" -o /dev/null -w "%{http_code}" "$link")
    c2=$(curl -s -m 10 -b "$app_jar" -o "$TMP/dash.html" -w "%{http_code}" "$BASE/")
    if [[ $c == 302 && $c2 == 200 ]] && grep -qi "<html" "$TMP/dash.html"; then pass "STRICT: the app sign-in path (coral open link) lands on the dashboard"; else fail "STRICT: sign-in $c then / $c2"; fi
    c=$(code_of -b "$app_jar" "$link"); [[ $c == 403 ]] && pass "STRICT: the used sign-in link cannot be replayed (403)" || fail "STRICT: replay answered $c"

    # #3424: an agent's token can't start code on this computer (task runs, workflows, jobs).
    c=$(code_of -X POST "$BASE/api/tasks/run" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{"prompt":"x","repo_path":"/tmp"}')
    c2=$(code_of -X POST "$BASE/api/workflows" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{"name":"x","steps":[{"name":"s","type":"shell","command":"true"}]}')
    EXP_AGENT_OP=2
    [[ $c == 403 && $c2 == 403 ]] && pass "STRICT: an agent's token can't start a task run or create a workflow (403 forbidden_for_agent)" || fail "STRICT: agent task run answered $c, workflow $c2"

    # #3445: nor change Coral's settings (cli_path_* is persistent code execution) or stop the Operator's runs;
    # launching agents stays allowed (a team launches its agents) and is recorded.
    c3=$(code_of -X PUT "$BASE/api/settings" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{"cli_path_claude":"/bin/sh"}')
    c4=$(code_of -X POST "$BASE/api/workflows/runs/1/kill" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{}')
    c5=$(code_of -X POST "$BASE/api/tasks/runs/1/kill" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{}')
    EXP_AGENT_OP=$((EXP_AGENT_OP + 3))
    [[ $c3 == 403 && $c4 == 403 && $c5 == 403 ]] && pass "STRICT: an agent's token can't change Coral's settings or stop a workflow or task run (403 forbidden_for_agent)" || fail "STRICT: agent settings PUT answered $c3, workflow kill $c4, task kill $c5"
    [[ "$(api GET /api/settings | python3 -c 'import sys,json;print(json.load(sys.stdin).get("cli_path_claude",""))' 2>/dev/null)" != "/bin/sh" ]] && pass "STRICT: the refused settings change did not happen (cli_path_claude is not /bin/sh)" || fail "STRICT: cli_path_claude was changed by an agent"
    # #3445 (QA finding): the dashboard-provenance headers (Origin, Sec-Fetch-Site) are forgeable, so an agent token
    # plus those two headers must not mint a sign-in link (that made the agent the Operator) or rotate the API key.
    # (Webhooks were removed in #3646, so there is no webhook route to probe.)
    c7=$(code_of -X POST "$BASE/api/system/login-token" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -A "coral-agent/test" -d '{}')
    c8=$(code_of -X POST "$BASE/api/system/api-key/regenerate" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -A "coral-agent/test" -d '{}')
    EXP_AGENT_OP=$((EXP_AGENT_OP + 2))
    [[ $c7 == 403 && $c8 == 403 ]] && pass "STRICT: an agent token (even with forged Origin and Sec-Fetch-Site) can't mint a sign-in link or rotate the API key" || fail "STRICT: agent login-token $c7, key regenerate $c8"
    c6=$(code_of -X POST "$BASE/api/sessions/launch" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d '{}')
    [[ $c6 != 403 && $c6 != 401 ]] && pass "STRICT: an agent can still launch agents (a bad request is $c6, not a refusal)" || fail "STRICT: an agent launch was refused ($c6)"
    rj=$(report); grep -q "POST /api/sessions/launch" <<<"$rj" && pass "STRICT: the agent's launch is recorded in agent_operator_calls" || fail "STRICT: the agent launch is not in agent_operator_calls"

    # Refusals are exactly the deliberate probes (by reason), none anywhere else.
    refused_now=$(rjson 'json.dumps(d.get("refused",{}))')
    if python3 - "$refused_now" "$EXP_MISMATCH" "$EXP_TOKEN" "$EXP_DASH" "$EXP_AGENT_OP" <<'CHECKEOF'
import sys, json
got = json.loads(sys.argv[1]); want = {"identity_mismatch": int(sys.argv[2]), "session_token_required": int(sys.argv[3]), "dashboard_auth_required": int(sys.argv[4]), "forbidden_for_agent": int(sys.argv[5])}
sys.exit(0 if all(got.get(k, 0) == v for k, v in want.items()) and set(got) <= set(want) else 1)
CHECKEOF
    then pass "STRICT: the report's refused counts are exactly the deliberate probes ($refused_now)"; else fail "STRICT: refused $refused_now vs expected mismatch=$EXP_MISMATCH token=$EXP_TOKEN dash=$EXP_DASH"; fi
fi


# ── #3445, default mode: an agent's settings change, run kill and launch go through and are RECORDED ──
if [[ $STRICT != 1 ]]; then
    for req in "PUT /api/settings {}" "POST /api/workflows/runs/1/kill {}" "POST /api/tasks/runs/1/kill {}" "POST /api/sessions/launch {}"; do
        set -- $req
        curl -s -m 10 -o /dev/null -X "$1" "$BASE$2" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $itok" -A "coral-agent/test" -d "$3"
    done
    rj=$(report); miss=""
    for route in "PUT /api/settings" "POST /api/workflows/runs/{runID}/kill" "POST /api/tasks/runs/{runID}/kill" "POST /api/sessions/launch"; do grep -qF "$route" <<<"$rj" || miss="$miss [$route]"; done
    [[ -z "$miss" ]] && pass "an agent's settings change, run kills and launch are recorded in agent_operator_calls (log only in default mode)" || fail "not recorded in agent_operator_calls:$miss"
fi


# ── #11013: an agent's token reaches only the board it was launched on (join AND launch) ──────────────────
# Real stand-in agents with their real session tokens and the real coral-board. Checks (default and --strict):
#   launch    an agent of team A launching onto team B's board or the Operator's board, through launch and launch-team: refused
#             403 forbidden_for_agent, no session made; onto its own board works, as an Orchestrator starting a teammate
#   exact     two boards with one label: an agent is admitted only to the board it was launched on, by its exact key, refused for the
#             other and for an upper-case key; a restart and a wake keep it able to rejoin its own board
#   variants  a join of another team's board with a trailing slash, doubled slashes, Subscribe, SUBSCRIBE, an escaped letter in
#             'subscribe' and in the board key, and a query: none is a 200, none leaves a seat; and coral-board join itself: exit 5
#   listing   a launch by another team's board NAME answers 409 without describing that board to the agent
live_json() { api GET /api/sessions/live | python3 -c 'import sys,json
d=json.load(sys.stdin); d=d.get("sessions",d) if isinstance(d,dict) else d
print(json.dumps(d))'; }
live_count() { live_json | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))'; }
# '<name> <session_id>' of the live agents whose board key is $1
agents_on() { live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s.get("board_project")==sys.argv[1]: print(s["name"], s["session_id"])' "$1"; }
token_of() { sed -n 's/^CORAL_SESSION_TOKEN=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
sess_of() { sed -n 's/^CORAL_SESSION_NAME=//p' "$DUMP/$1.env" 2>/dev/null | head -1; }
tok_post() { # tok_post <token> <method> <path> [body] -> "<status> <body>"
    local tok=$1 m=$2 path=$3 body=${4:-}
    curl -s -m 20 -w ' HTTP%{http_code}' -X "$m" "$BASE$path" -H "Content-Type: application/json" -H "X-Coral-Session-Token: $tok" -A "coral-board/test" ${body:+-d "$body"}
}
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }   # bash 3.2 (macOS) has no ${x^^}
role_of() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('job_title',''))" "$(NP "$DATA/board_state_$(sess_of "$1").json")" 2>/dev/null; } # the role/subscriber name an agent joined as
seated() { api GET "/api/board/$1/subscribers" | grep -c -F "$2" || true; } # seats on board $1 whose session name is $2
section_11013() {
    set +e   # every check below reports its own result: one failing step must not end the run (it is how this section shows the hole on a build that has it)
    wait_sessions_ready || log "no live agent has its dump yet"
    local line
    line=$(live_json | python3 -c 'import sys,json
d=json.load(sys.stdin)
a=[s for s in d if str(s.get("board_label",""))=="id-team-1" and (s.get("display_name") or "")=="Orchestrator"]
b=[s for s in d if str(s.get("board_label",""))=="id-team-2"]
print(a[0]["session_id"], a[0]["board_project"], b[0]["board_project"]) if a and b else print("")')
    if [[ -z "$line" ]]; then fail "#11013: no Orchestrator of id-team-1 and agent of id-team-2 to probe with"; set -e; return; fi
    local osid own other otok osess
    read -r osid own other <<<"$line"
    otok=$(token_of "$osid"); osess=$(sess_of "$osid")
    [[ -n "$otok" && -n "$osess" ]] || { fail "#11013: the Orchestrator's dump has no token"; set -e; return; }
    local opsid
    opsid=$(api POST /api/board/id-ops/subscribe -d '{"subscriber_id":"Operator","job_title":"Operator"}' | python3 -c 'import sys,json; print(json.load(sys.stdin).get("project",""))' 2>/dev/null || true)
    [[ -n "$opsid" ]] || opsid=id-ops

    # launch ---------------------------------------------------------------------------
    local before after out ok=1
    before=$(live_count)
    for target in "$other" "$opsid"; do
        out=$(tok_post "$otok" POST /api/sessions/launch "{\"working_dir\":\"$(NP "$TMP/w")\",\"agent_type\":\"claude\",\"board_id\":\"$target\",\"display_name\":\"Intruder\",\"prompt\":\"x\"}")
        [[ "$out" == *forbidden_for_agent*HTTP403 ]] || { fail "#11013 launch onto $target by an agent answered: ${out:0:160}"; ok=0; }
        out=$(tok_post "$otok" POST /api/sessions/launch-team "{\"working_dir\":\"$(NP "$TMP/w")\",\"board_id\":\"$target\",\"agents\":[{\"agent_type\":\"claude\",\"name\":\"Intruder\",\"prompt\":\"x\"}]}")
        [[ "$out" == *forbidden_for_agent*HTTP403 ]] || { fail "#11013 team launch onto $target by an agent answered: ${out:0:160}"; ok=0; }
    done
    sleep 1; after=$(live_count)
    [[ $after -eq $before ]] || { fail "#11013: a refused launch still made a session ($before -> $after)"; ok=0; }
    [[ $(seated "$other" Intruder) -eq 0 && $(seated "$opsid" Intruder) -eq 0 ]] || { fail "#11013: a refused launch seated an agent"; ok=0; }
    [[ $ok == 1 ]] && pass "#11013: an agent's launch and team launch onto another team's board and the Operator's are refused (403 forbidden_for_agent), no session made, no seat"
    out=$(tok_post "$otok" POST /api/sessions/launch "{\"working_dir\":\"$(NP "$TMP/w")\",\"agent_type\":\"claude\",\"board_id\":\"$own\",\"display_name\":\"Mate\",\"prompt\":\"x\"}")
    [[ "$out" == *HTTP200 && "$out" == *'"ok":true'* ]] && pass "#11013: an Orchestrator starting a teammate on its own board works" || fail "#11013: the Orchestrator's launch on its own board answered: ${out:0:200}"

    # listing --------------------------------------------------------------------------
    out=$(tok_post "$otok" POST /api/sessions/launch "{\"working_dir\":\"$(NP "$TMP/w")\",\"agent_type\":\"claude\",\"board_name\":\"id-team-2\",\"prompt\":\"x\"}")
    if [[ "$out" == *board_name_exists*HTTP409 && "$out" != *"$other"* && "$out" != *live_agents* ]]; then
        pass "#11013: a launch by another team's board name answers 409 without describing that board (no id, no counts)"
    else
        fail "#11013: the 409 for another team's board name: ${out:0:240}"
    fi

    # exact match: two boards with one label ----------------------------------------------
    local t
    for t in 1 2; do
        api POST /api/sessions/launch-team -d "{\"board_name\":\"id-twin\",\"new_board\":true,\"working_dir\":\"$(NP "$TMP/w")\",\"agents\":[{\"agent_type\":\"claude\",\"name\":\"Twin $t\",\"prompt\":\"x\"}]}" >/dev/null
    done
    local twins; twins=$(live_json | python3 -c 'import sys,json
print(" ".join(sorted({s["board_project"] for s in json.load(sys.stdin) if str(s.get("board_label",""))=="id-twin"})))')
    local b1 b2; read -r b1 b2 <<<"$twins"
    if [[ -z "$b1" || -z "$b2" ]]; then fail "#11013: two boards labelled id-twin were not made ($twins)"; else
        local s1 s2 k1 k2 n1 n2
        read -r _ s1 <<<"$(agents_on "$b1" | head -1)"; read -r _ s2 <<<"$(agents_on "$b2" | head -1)"
        wait_until 40 "the twin agents' tokens" bash -c "grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$s1.env' 2>/dev/null && grep -q '^CORAL_SESSION_TOKEN=' '$DUMP/$s2.env' 2>/dev/null" || true
        k1=$(token_of "$s1"); n1=$(sess_of "$s1"); local r1 r1keep; r1=$(role_of "$s1"); r1keep=$r1
        ok=1
        out=$(tok_post "$k1" POST "/api/board/$b1/subscribe" "{\"subscriber_id\":\"$r1\",\"job_title\":\"$r1\",\"session_name\":\"$n1\"}"); [[ "$out" == *HTTP200 ]] || { fail "#11013 exact: the agent could not rejoin its own board $b1: ${out:0:160}"; ok=0; }
        for other_key in "$b2" "$(upper "$b1")" "$(upper "$b2")"; do
            out=$(tok_post "$k1" POST "/api/board/$other_key/subscribe" "{\"subscriber_id\":\"$r1\",\"job_title\":\"$r1\",\"session_name\":\"$n1\"}")
            [[ "$out" == *HTTP403 ]] || { fail "#11013 exact: a join of $other_key (its own board is $b1) answered ${out: -7}, want HTTP403: ${out:0:120}"; ok=0; }
        done
        [[ $(seated "$b2" "$n1") -eq 0 ]] || { fail "#11013 exact: a seat was made on the other twin board"; ok=0; }
        [[ $ok == 1 ]] && pass "#11013 exact: of two boards labelled id-twin the agent is admitted only to its own by exact key, refused for the other and for upper-case keys"
        # a restart and a wake keep it able to rejoin its own board (the live row carries the board over)
        local nm1; read -r nm1 _ <<<"$(agents_on "$b1" | head -1)"
        api POST "/api/sessions/live/$nm1/restart" -d "{\"session_id\":\"$s1\",\"agent_type\":\"claude\"}" >/dev/null
        local ns1=""
        local end=$((SECONDS + 60))
        while (( SECONDS < end )); do
            read -r _ ns1 <<<"$(agents_on "$b1" | head -1)"
            [[ -n "$ns1" ]] && grep -q '^CORAL_SESSION_TOKEN=' "$DUMP/$ns1.env" 2>/dev/null && break
            sleep 1
        done
        k1=$(token_of "$ns1"); n1=$(sess_of "$ns1"); r1=$(role_of "$ns1" || true); r1=${r1:-$r1keep}
        out=$(tok_post "$k1" POST "/api/board/$b1/subscribe" "{\"subscriber_id\":\"$r1\",\"job_title\":\"$r1\",\"session_name\":\"$n1\"}")
        [[ "$out" == *HTTP200 ]] && pass "#11013 exact: after a restart the agent still rejoins its own board" || fail "#11013 exact: after a restart the rejoin answered: ${out:0:160}"
        out=$(tok_post "$k1" POST "/api/board/$b2/subscribe" "{\"subscriber_id\":\"$r1\",\"job_title\":\"$r1\",\"session_name\":\"$n1\"}")
        [[ "$out" == *HTTP403 && "$out" == *identity_mismatch* ]] && pass "#11013 exact: after a restart the other twin board is still refused (403 identity_mismatch)" || fail "#11013 exact: after a restart the other twin board answered ${out: -7}, want HTTP403 identity_mismatch: ${out:0:120}"
        api POST "/api/sessions/live/$ns1/sleep" -d '{}' >/dev/null; sleep 2
        api POST "/api/sessions/live/$ns1/wake" -d '{}' >/dev/null
        local wk=""; end=$((SECONDS + 60))
        while (( SECONDS < end )); do
            wk=$(token_of "$ns1"); [[ -n "$wk" && "$wk" != "$k1" ]] && break; sleep 1
        done
        out=$(tok_post "${wk:-$k1}" POST "/api/board/$b1/subscribe" "{\"subscriber_id\":\"$r1\",\"job_title\":\"$r1\",\"session_name\":\"$n1\"}")
        [[ "$out" == *HTTP200 ]] && pass "#11013 exact: after a wake the agent still rejoins its own board" || fail "#11013 exact: after a wake the rejoin answered: ${out:0:160}"
    fi

    # a seat the Operator makes on another board does not move the agent: after a restart its live row board, its seat, its
    # command-line state and its own-reach board are still its launch board (a restart used to take the board of its NEWEST seat)
    if [[ -n "$b1" && -n "$b2" && -n "${ns1:-}" ]]; then
        local moved_name moved_old moved_new tries
        moved_old=$ns1; moved_name=$(sess_of "$moved_old")
        api POST "/api/board/$b2/subscribe" -d "{\"subscriber_id\":\"Seated Guest\",\"job_title\":\"Guest\",\"session_name\":\"$moved_name\"}" >/dev/null
        sleep 2   # a seat's time has a one second resolution: the Operator's seat must be the newer
        local lname; lname=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s["name"])' "$moved_old")
        local envs_before; envs_before=$(ls "$DUMP"/*.env 2>/dev/null | tr '\n' ' ')
        api POST "/api/sessions/live/$lname/restart" -d "{\"session_id\":\"$moved_old\",\"agent_type\":\"claude\"}" >/dev/null
        moved_new=""; end=$((SECONDS + 60))
        while (( SECONDS < end )); do
            for f in "$DUMP"/*.env; do [[ " $envs_before " != *" $f "* ]] && grep -q '^CORAL_SESSION_TOKEN=' "$f" 2>/dev/null && moved_new=$(basename "$f" .env); done
            [[ -n "$moved_new" ]] && break; sleep 1
        done
        if [[ -z "$moved_new" ]]; then fail "#11013 restart: the restarted agent never came back"; else
            local nname newboard state_project okr=1
            nname=$(sess_of "$moved_new")
            newboard=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s.get("board_project",""))' "$moved_new")
            state_project=$(python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('project',''))" "$(NP "$DATA/board_state_$nname.json")" 2>/dev/null || true)
            [[ "$newboard" == "$b1" ]] || { fail "#11013 restart: the restarted agent's live row board is '$newboard', want its launch board $b1"; okr=0; }
            [[ $(seated "$b1" "$nname") -ge 1 ]] || { fail "#11013 restart: the restarted agent holds no seat on its launch board"; okr=0; }
            [[ $(seated "$b2" "$nname") -eq 0 ]] || { fail "#11013 restart: the restarted agent was seated on the Operator's other board"; okr=0; }
            [[ "$state_project" == "$b1" ]] || { fail "#11013 restart: its command-line state names '$state_project', want $b1"; okr=0; }
            [[ $okr == 1 ]] && pass "#11013 restart: seated elsewhere by the Operator, then restarted: the agent's live row, seat and command-line state are still its launch board"
        fi
    fi

    # the agent LEAVES its own launch board with the real coral-board while it still holds a leftover seat on another board (the old hole's, or the
    # Operator's), then restarts: the newest seat of the other board must not become its board; it comes back on its launch board and is re-seated there
    if [[ -n "${moved_new:-}" && -n "$b1" && -n "$b2" ]]; then
        local l_old l_name l_role l_tok okl=1
        l_old=$moved_new; l_name=$(sess_of "$l_old"); l_role=$(role_of "$l_old"); l_tok=$(token_of "$l_old")
        api POST "/api/board/$b2/subscribe" -d "{\"subscriber_id\":\"Leftover Seat\",\"job_title\":\"Guest\",\"session_name\":\"$l_name\"}" >/dev/null
        sleep 2
        out=$(env -i ${WIN_ENV[@]+"${WIN_ENV[@]}"} PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" CORAL_SESSION_TOKEN="$l_tok" CORAL_SESSION_NAME="$l_name" CORAL_SUBSCRIBER_ID="$l_role" "$BIN/coral-board" leave 2>&1) && rc=0 || rc=$?
        if [[ $rc -eq 0 && "$out" == *Left* && $(seated "$b1" "$l_name") -eq 0 ]]; then
            local lname2; lname2=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s["name"])' "$l_old")
            local envs_before2; envs_before2=$(ls "$DUMP"/*.env 2>/dev/null | tr '\n' ' ')
            api POST "/api/sessions/live/$lname2/restart" -d "{\"session_id\":\"$l_old\",\"agent_type\":\"claude\"}" >/dev/null
            local l_new=""; end=$((SECONDS + 60))
            while (( SECONDS < end )); do
                for f in "$DUMP"/*.env; do [[ " $envs_before2 " != *" $f "* ]] && grep -q '^CORAL_SESSION_TOKEN=' "$f" 2>/dev/null && l_new=$(basename "$f" .env); done
                [[ -n "$l_new" ]] && break; sleep 1
            done
            if [[ -z "$l_new" ]]; then fail "#11013 leave then restart: the restarted agent never came back"; else
                local l_nname l_board l_state
                l_nname=$(sess_of "$l_new")
                l_board=$(live_json | python3 -c 'import sys,json
for s in json.load(sys.stdin):
    if s["session_id"]==sys.argv[1]: print(s.get("board_project",""))' "$l_new")
                l_state=$(python3 -c "import sys,json;print(json.load(open(sys.argv[1])).get('project',''))" "$(NP "$DATA/board_state_$l_nname.json")" 2>/dev/null || true)
                [[ "$l_board" == "$b1" ]] || { fail "#11013 leave then restart: the live row board is '$l_board', want its launch board $b1"; okl=0; }
                [[ $(seated "$b1" "$l_nname") -ge 1 ]] || { fail "#11013 leave then restart: it was not re-seated on its launch board"; okl=0; }
                [[ $(seated "$b2" "$l_nname") -eq 0 ]] || { fail "#11013 leave then restart: it was seated on the other board"; okl=0; }
                [[ "$l_state" == "$b1" ]] || { fail "#11013 leave then restart: its command-line state names '$l_state', want $b1"; okl=0; }
                [[ $okl == 1 ]] && pass "#11013 leave then restart: after the real coral-board leave on its launch board, with a leftover seat elsewhere, a restart brings the agent back on its launch board and seats it there, none on the other board"
            fi
        else
            fail "#11013 leave then restart: coral-board leave rc=$rc ${out:0:140} (seat left on the launch board: $(seated "$b1" "$l_name"))"
        fi
    fi

    # variants and the real CLI ----------------------------------------------------------
    ok=1; local path want
    local ptok="$otok" pname="$osess" prole; prole=$(role_of "$osid")   # the agent's OWN subscriber name: a join under another name is refused for that, which would hide the board gate
    local pbody="{\"subscriber_id\":\"$prole\",\"job_title\":\"$prole\",\"session_name\":\"$pname\"}"
    # positive control, same token and body: its OWN board answers 200, so a refusal below is the board gate and not a bad token, body or a down server
    out=$(tok_post "$ptok" POST "/api/board/$own/subscribe" "$pbody")
    [[ "$out" == *HTTP200 ]] && pass "#11013 variants: the control (the same token joining its own board) answers 200" || { fail "#11013 variants: the positive control answered ${out: -7}: ${out:0:160}"; ok=0; }
    for path in "/api/board/$other/subscribe" "/api/board/$other/subscribe/" "/api/board//$other/subscribe" "/api/board/$other//subscribe" "/api/board/$other/Subscribe" \
                "/api/board/$other/SUBSCRIBE" "/api/board/$other/%73ubscribe" "/api/board/$(printf '%%%02x' "'${other:0:1}")${other:1}/subscribe" "/api/board/$other/subscribe?x=1" "/api/board/$(upper "$other")/subscribe"; do
        want=403   # the gate refuses every form that reaches a board route; only a doubled slash BEFORE the board is not a board route at all
        [[ "$path" == "/api/board//$other/subscribe" ]] && want=404
        out=$(tok_post "$ptok" POST "$path" "$pbody")
        [[ "$out" == *HTTP$want ]] || { fail "#11013 variant $path answered ${out: -7}, want HTTP$want: ${out:0:140}"; ok=0; }
    done
    [[ $(seated "$other" "$pname") -eq 0 ]] || { fail "#11013 variants left a seat on $other"; ok=0; }
    [[ $ok == 1 ]] && pass "#11013: joins of another team's board by path variants (slashes, case, escapes, a query) are never a 200 and leave no seat"
    # the real coral-board from the agent's own environment: its own board is admitted, another team's is exit 5 with the Operator's words
    local state="$DATA/board_state_$osess.json" role
    role=$(python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(d.get('job_title',''))" "$(NP "$state")" 2>/dev/null || true)
    local cli=(env -i ${WIN_ENV[@]+${WIN_ENV[@]+"${WIN_ENV[@]}"}} PATH="$PATH" HOME="$(NP "$TMP/h")" USERPROFILE="$(NP "$TMP/h")" CORAL_DATA_DIR="$(NP "$DATA")" CORAL_URL="$BASE" CORAL_SESSION_TOKEN="$otok" CORAL_SESSION_NAME="$osess" CORAL_SUBSCRIBER_ID="$role" "$BIN/coral-board")
    cp "$state" "$TMP/state.keep" 2>/dev/null || true
    out=$("${cli[@]}" join "$own" --as "$role" 2>&1) && rc=0 || rc=$?
    [[ $rc -eq 0 ]] && pass "#11013: coral-board join of the agent's own board works from its own environment (exit 0)" || fail "#11013: coral-board join of its own board: rc=$rc ${out:0:200}"
    cp "$TMP/state.keep" "$state" 2>/dev/null || true
    out=$("${cli[@]}" join "$other" --as "$role" 2>&1) && rc=0 || rc=$?
    cp "$TMP/state.keep" "$state" 2>/dev/null || true
    if [[ $rc -eq 5 && "$out" == *"can join only the board it was launched on"* && "$out" == *"the Operator can seat it there"* ]]; then
        pass "#11013: coral-board join of another team's board exits 5 with the words for the Operator"
    else
        fail "#11013: coral-board join of another team's board: rc=$rc ${out:0:240}"
    fi
    [[ $(seated "$other" "$osess") -eq 0 ]] && pass "#11013: ...and left no seat on that board" || fail "#11013: the CLI join left a seat on another team's board"
    set -e
}
section_11013

log "What strict mode would refuse, by caller, tool and route (#3418; this script's own curl calls are local_other curl):"
report | python3 -c '
import sys, json
for k, v in sorted(json.load(sys.stdin).get("would_break_by_route", {}).items(), key=lambda kv: -kv[1]):
    print("[identity]   %5d  %s" % (v, k))'
coral_test_sandbox_check || FAIL=$((FAIL + 1))   # #4354
log "Done: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
