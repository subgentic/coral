#!/usr/bin/env bash
# update_real.sh: the auto-update chain with REAL releases (#9030). FROM is installed in a folder of its own, run with a fresh HOME and data folder, and its own
# updater finds, verifies and stages TO on GitHub, then installs it the way a person does (Update and relaunch), with a tmux agent running through it.
#
#   tests/release/update_real.sh [--from v2.0.0] [--to v2.0.1] [--check-only] [--keep] [--timeout SECONDS]
#
# macOS only for now (the tray, the app swap). FROM must be a release whose updater can apply (v1.4.167 and later on macOS). TO must be the release GitHub marks
# latest (the approved channel): the updater never stages a pre-release, so run this after the release is approved. With FROM equal to TO it is a dry run of
# the finding: the updater must say up to date and nothing is staged. tools/devops/update_check.md has the plan and what each item proves.
#
# It never runs the installed Coral and never reads ~/.coral: every program is the one in FROM's own DMG, copied to $work/app, started with HOME and CORAL_DATA_DIR
# in $work, CORAL_CLOUD_URL=off, a random port, and the stand-in agent CLI of smoke_macos.sh. The only network traffic is the updater's and the release downloads
# (gh): GitHub and the Sigstore TUF mirror. Every process is stopped by a pid this script recorded; the tmux server by the socket in its own data folder; the work
# folder by its own path (--keep leaves it).
#
#   1 download   FROM's DMG has the sha256 in its SHA256SUMS.txt, and the app is codesign-valid
#   2 start      the app's tray starts the server (FROM answers /api/health), with the tmux backend, and the stand-in agent is a tmux session
#   3 find       a check finds TO: staged, verified (Sigstore and SHA256SUMS, the updater's own), the relaunch available with its acknowledgement
#   4 ask        not the person (an API key, an agent's token) is refused and nothing starts
#   (items 5 to 8 only on a GitHub-hosted runner or with --throwaway-machine: see below)
#   5 apply      the person's request (signed with the data folder's command-line token) installs TO and relaunches: the server answers TO, the old one is gone
#   6 install    the app is TO (Info.plist), codesign-valid and accepted by spctl, coral-update says installed TO and no failed apply
#   7 tmux       the agent's tmux session is the same session with the same pane process (or, when TO's bundled tmux is another build, a session again)
#   8 settled    a second check says up to date
#
# The apply (items 5 to 8) starts the new app with /usr/bin/open, which gives it the login session's environment, not the HOME and data folder of this run. On a person's own Mac it would
# start against the real data folder, so those items run only on a GitHub-hosted runner or with --throwaway-machine (a Mac that is not someone's own). Items 1 to 4 are safe anywhere.
#
# Output: one table; exit status 0 only when no item FAILs. Needs macOS, curl, lsof, python3, hdiutil, codesign, spctl, shasum, go, gh.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
. "$root/tools/release-homes.sh"
from=v2.0.0 to=v2.0.1 keep=0 checkonly=0 tmo=240 throwaway=0
[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] && throwaway=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from=${2:?--from TAG}; shift 2 ;;
    --to) to=${2:?--to TAG}; shift 2 ;;
    --check-only) checkonly=1; shift ;;
    --keep) keep=1; shift ;;
    --throwaway-machine) throwaway=1; shift ;;
    --timeout) tmo=${2:?--timeout SECONDS}; shift 2 ;;
    -h|--help) sed -n 2,30p "$0"; exit 0 ;;
    *) echo "update_real: unknown option $1" >&2; exit 2 ;;
  esac
done
# the tag regex of the update-real-macos workflow (a plain release tag, or one of the build-suffixed ones): nothing else reaches a URL, a path or a command
tag_re='^v[0-9]+\.[0-9]+\.[0-9]+(-(rc[0-9]*|beta|dev|forDropbox))?$'
for t in "$from" "$to"; do [[ "$t" =~ $tag_re ]] || { echo "update_real: not a release tag, refused: $t" >&2; exit 2; }; done
[ "$(uname -s)" = Darwin ] || { echo "update_real: macOS only (the Linux tarball run is in tools/devops/update_check.md)" >&2; exit 2; }
for t in curl lsof python3 hdiutil codesign spctl shasum go gh; do command -v "$t" >/dev/null || { echo "update_real: needs $t" >&2; exit 2; }; done
fromv=${from#v}; tov=${to#v}

work=$(mktemp -d /tmp/coral-upd.XXXXXX) || exit 2   # short path: tmux and pty sockets have a length limit
PIDS=()
mounted=0
DD="$work/d"; HH="$work/h"
app="$work/app/Coral.app"
oldtmux="$work/tmux-from"
# at cleanup a recorded pid is killed only if its program is still a file of this work folder (a pid that ended and was reused by another process is never killed)
in_work() { local c; c=$(ps -o command= -p "$1" 2>/dev/null); case "$c" in "$work"/*) return 0 ;; *) return 1 ;; esac; }
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do in_work "$p" && kill "$p" 2>/dev/null; done
  sleep 2
  for p in ${PIDS[@]+"${PIDS[@]}"}; do in_work "$p" && kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  # the tmux server of this run outlives Coral on purpose: stop it by the socket of this run's own data folder
  if [ -S "$DD/tmux.sock" ]; then
    for t in "$oldtmux" "$app/Contents/MacOS/tmux"; do [ -x "$t" ] && "$t" -S "$DD/tmux.sock" kill-server 2>/dev/null && break; done
  fi
  [ "$mounted" = 1 ] && hdiutil detach "$work/mnt" -quiet 2>/dev/null
  if [ "$keep" = 1 ]; then echo "update_real: kept $work"; else case "$work" in /tmp/coral-upd.??????) rm -rf -- "$work" ;; esac; fi
}
trap cleanup EXIT

NAMES=() STATES=() DETAILS=()
result() { NAMES+=("$1"); STATES+=("$2"); DETAILS+=("$3"); [ "$2" = PASS ] || echo "update_real: $2 $1: $3" >&2; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
jget() { python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    for k in sys.argv[1].split("."):
        d = d[int(k)] if isinstance(d, list) else d.get(k)
    print("" if d is None else d)
except Exception:
    print("")' "$1" 2>/dev/null; }
finish() {
  echo
  printf '%-12s %-5s %s\n' item state detail
  local i fail=0
  for i in "${!NAMES[@]}"; do printf '%-12s %-5s %s\n' "${NAMES[$i]}" "${STATES[$i]}" "${DETAILS[$i]}"; [ "${STATES[$i]}" = PASS ] || [ "${STATES[$i]}" = SKIP ] || fail=1; done
  exit "$fail"
}

# ---- 1 download --------------------------------------------------------------------------------------------
mkdir -p "$work/dl" "$work/mnt" "$work/app" "$work/wd" "$HH/.coral" "$HH/.claude/projects" "$DD" "$work/bin"
if ! gh release download "$from" -R "$(release_home_current)" -p 'Coral*.dmg' -p SHA256SUMS.txt -D "$work/dl" >/dev/null 2>&1; then
  result "1 download" FAIL "could not download $from"; finish
fi
dmg=$(ls "$work"/dl/Coral*.dmg 2>/dev/null | head -1)
want=$(grep -E " \*?$(basename "$dmg")\$" "$work/dl/SHA256SUMS.txt" | head -1 | cut -d' ' -f1)
got=$(shasum -a 256 "$dmg" | cut -d' ' -f1)
if [ -z "$want" ] || [ "$want" != "$got" ]; then result "1 download" FAIL "sha256 of $(basename "$dmg") is $got, SHA256SUMS.txt says [$want]"; finish; fi
if hdiutil attach -readonly -nobrowse -mountpoint "$work/mnt" "$dmg" >/dev/null 2>&1; then mounted=1; fi
if [ "$mounted" != 1 ] || ! cp -R "$work/mnt/Coral.app" "$work/app/"; then result "1 download" FAIL "could not mount or copy the app"; finish; fi
hdiutil detach "$work/mnt" -quiet 2>/dev/null && mounted=0
if ! codesign --verify --deep --strict "$app" 2>"$work/cs.txt"; then result "1 download" FAIL "codesign: $(head -c 200 "$work/cs.txt")"; finish; fi
cp "$app/Contents/MacOS/tmux" "$oldtmux"
result "1 download" PASS "$(basename "$dmg") is the sha256 of SHA256SUMS.txt ($(printf %.12s "$got")); codesign-valid"

# the stand-in for the person at this computer (a request signed with the data folder's command-line token), built from this tree
if ! (cd "$root/coral-go" && CGO_ENABLED=0 go build -o "$work/bin/person-call" ./internal/updater/testrig/cmd/person-call) 2>"$work/pc.txt"; then
  result "2 start" FAIL "could not build person-call: $(head -c 200 "$work/pc.txt")"; finish
fi

# ---- 2 start -----------------------------------------------------------------------------------------------
echo accepted > "$HH/.coral/.eula-accepted"
PORT=$(free_port)
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HH" CORAL_DATA_DIR="$DD" CORAL_CLOUD_URL=off CORAL_TELEMETRY_DISABLED=1 \
  "$app/Contents/MacOS/coral-tray" --foreground --no-browser --port "$PORT" --home "$HH" --backend tmux > "$work/tray.out" 2>&1 & TRAY=$!
PIDS+=("$TRAY"); disown "$TRAY"
for i in $(seq 1 120); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
# a pid is recorded for kill only when it is this run's own: the tray's child, or a program started from this run's work folder (a port reused by another process is never killed)
ours() { local p=$1 pp cmd; [ -n "$p" ] || return 1; pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); cmd=$(ps -o command= -p "$p" 2>/dev/null); [ "$pp" = "${TRAY:-0}" ] || case "$cmd" in "$work"/*) return 0 ;; *) return 1 ;; esac; }
SRV0=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$SRV0" ] && ours "$SRV0"; then PIDS+=("$SRV0"); else [ -n "$SRV0" ] && echo "update_real: the process on :$PORT ($SRV0) is not this run's tray or server: not recorded, not killed" >&2; SRV0=""; fi
for i in $(seq 1 80); do [ -r "$DD/api_key" ] && break; sleep 0.5; done
KEY=$(tr -d '[:space:]' < "$DD/api_key" 2>/dev/null)
base="http://127.0.0.1:$PORT"
# the throwaway instance's API key goes to curl from files (-H @file), never on a command line that ps shows
( umask 077; printf 'Authorization: Bearer %s\n' "$KEY" > "$work/hdr.auth"; printf 'X-API-Key: %s\n' "$KEY" > "$work/hdr.key" )
api() { curl -s -m 30 -H @"$work/hdr.auth" -H 'Content-Type: application/json' "$@"; }
person() { env -i HOME="$HH" PATH=/usr/bin:/bin "$work/bin/person-call" --data-dir "$DD" --url "$base" "$@"; }   # prints "CODE body"
pbody() { sed 's/^[0-9]* //'; }
health() { curl -s -m 5 "$base/api/health" | jget version; }
upd_env() { env -i HOME="$HH" PATH=/usr/bin:/bin CORAL_DATA_DIR="$DD" CORAL_CLOUD_URL=off CORAL_TELEMETRY_DISABLED=1 "$app/Contents/MacOS/coral-update" "$@"; }
if [ -z "$SRV0" ] || [ -z "$KEY" ] || [ "$(health)" != "$fromv" ]; then
  result "2 start" FAIL "server=[$SRV0] key=[${KEY:+set}] health=[$(health)] want $fromv; tray: $(tail -c 300 "$work/tray.out" | tr '\n' ' ')"; finish
fi
api -X PUT -d "{\"cli_path_claude\":\"$here/smoke_macos/standin_cli.py\",\"telemetry_enabled\":false}" "$base/api/settings" >/dev/null
launch=$(api -X POST -d "{\"working_dir\":\"$work/wd\",\"display_name\":\"survivor\"}" "$base/api/sessions/launch")
terminal=$(printf '%s' "$launch" | jget terminal)
sleep 4
panes() { local t; for t in "$oldtmux" "$app/Contents/MacOS/tmux"; do [ -x "$t" ] && "$t" -S "$DD/tmux.sock" list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null && return 0; done; return 1; }
pane0=$(panes | head -1)
if [ "$terminal" = tmux ] && [ -n "$pane0" ]; then
  result "2 start" PASS "$fromv answers /api/health on :$PORT (tray $TRAY, server $SRV0); the stand-in agent is the tmux session [$pane0]"
else
  result "2 start" FAIL "launch=[$(printf '%s' "$launch" | head -c 200)] terminal=[$terminal] panes=[$pane0]"; finish
fi

# ---- 3 find ------------------------------------------------------------------------------------------------
# Evidence for a check that failed (#9075): what the updater logged for it, and the GitHub rate limit it ran under. The updater asks GitHub without a token (60 requests an hour per address,
# shared by every run on the same runner address); a 403 with x-ratelimit-remaining 0 is that limit, not a Coral fault.
diag_failure() {
  echo "update_real: ---- evidence for the failed check ----" >&2
  echo "update_real: the updater's own status (coral-update status):" >&2
  upd_env status 2>&1 | head -30 | sed 's/^/    /' >&2
  echo "update_real: the server's [update] log lines (stage and HTTP status are in them):" >&2
  { grep -h '\[update\]' "$work/tray.out" 2>/dev/null; grep -hr '\[update\]' "$DD"/*.log "$HH"/.coral/*.log 2>/dev/null; } | tail -20 | sed 's/^/    /' >&2
  echo "update_real: GitHub's rate limit as the updater sees it (unauthenticated) and as gh does:" >&2
  curl -s -m 15 -D - -o /dev/null https://api.github.com/rate_limit 2>/dev/null | tr -d '\r' | grep -iE '^(HTTP/|x-ratelimit-(limit|remaining|reset|resource)|retry-after)' | sed 's/^/    /' >&2
  gh api rate_limit --jq '"    gh (authenticated): core remaining \(.resources.core.remaining) of \(.resources.core.limit), resets \(.resources.core.reset)"' 2>&1 | head -2 >&2
  echo "update_real: ---- end of the evidence ----" >&2
}
# Evidence for an apply that did not come up on this run's port (item 5): the apply restarts Coral through open(1), which gives the new app the login session's environment, not this run's
# port, so the new Coral may be up on its default port. Print what is there so the next run says which case it is. Only called on a throwaway runner (items 5 to 8 run nowhere else).
diag_apply() {
  echo "update_real: ---- evidence for the failed apply ----" >&2
  echo "update_real: Coral processes after the apply (pid, ppid, command):" >&2
  ps -axo pid=,ppid=,command= 2>/dev/null | grep -iE '[C]oral' | head -15 | sed 's/^/    /' >&2
  echo "update_real: what Coral processes listen on:" >&2
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE 'coral' | head -10 | sed 's/^/    /' >&2
  echo "update_real: health on this run's port ($PORT) and on the default port (8420):" >&2
  echo "    run port: [$(health)]  8420: [$(curl -s -m 5 http://127.0.0.1:8420/api/health | jget version)]" >&2
  echo "update_real: the installed app's version (Info.plist): $(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)" >&2
  echo "update_real: ---- end of the evidence ----" >&2
}
checked_at() { person --path /api/system/update | pbody | jget checked_at; }
start_check() { person --method POST --path /api/system/update/check | grep -q '^202'; }
before=$(checked_at)
start_check || { result "3 find" FAIL "the check was not accepted: $(person --method POST --path /api/system/update/check)"; finish; }
st=""; deadline=$(( $(date +%s) + tmo )); retried=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # the status is read only once the check is over (a read made while it runs makes the check fail as a network error, see the plan): checked_at changes when it ends
  now=$(checked_at)
  if [ -z "$now" ] || [ "$now" = "$before" ]; then sleep 3; continue; fi
  st=$(person --path /api/system/update | pbody)
  reason=$(printf '%s' "$st" | jget not_ready_reason)
  if [ "$reason" = backoff ] || [ "$reason" = check_failed ]; then
    echo "update_real: the updater says $reason after the check at $now" >&2
    diag_failure
    if [ "$retried" = 0 ]; then
      retried=1; echo "update_real: retrying the check once after 65 s (one check a minute; a failure backs the next one off, up to a day)" >&2
      sleep 65; before=$now; start_check || { result "3 find" FAIL "the retry was not accepted: $(person --method POST --path /api/system/update/check)"; finish; }
      continue
    fi
    break
  fi
  if [ "$fromv" = "$tov" ]; then [ "$reason" = up_to_date ] && break; fi
  [ "$(printf '%s' "$st" | jget state)" = staged ] && [ "$(printf '%s' "$st" | jget relaunch.available)" = True ] && break
  sleep 5
done
tok=$(printf '%s' "$st" | jget relaunch.ack)
if [ "$fromv" = "$tov" ]; then
  if [ "$(printf '%s' "$st" | jget not_ready_reason)" = up_to_date ] && [ "$(printf '%s' "$st" | jget relaunch.reason)" = nothing_staged ]; then
    result "3 find" PASS "dry run ($fromv to itself): the updater checked GitHub and says up to date, nothing staged, relaunch refused as nothing_staged"
  else result "3 find" FAIL "status: $(printf '%s' "$st" | head -c 500)"; fi
  result "4-8" SKIP "FROM is TO: nothing to install"; finish
fi
staged=$(printf '%s' "$st" | jget staged.version); verified=$(printf '%s' "$st" | jget staged.verified)
if [ "$staged" = "$tov" ] && [ "$verified" = True ] && [ -n "$tok" ]; then
  result "3 find" PASS "$tov is staged and verified by $fromv's updater, the relaunch is available with an acknowledgement token"
else
  result "3 find" FAIL "staged=[$staged] verified=[$verified] ack=[${tok:+set}] reason=[$(printf '%s' "$st" | jget relaunch.reason)] not_ready=[$(printf '%s' "$st" | jget not_ready_reason)]: $(printf '%s' "$st" | head -c 400)"; finish
fi
[ "$checkonly" = 1 ] && { result "4-8" SKIP "--check-only"; finish; }

# ---- 4 ask -------------------------------------------------------------------------------------------------
body="{\"ack\":\"$tok\"}"
c_key=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H @"$work/hdr.key" -H 'Content-Type: application/json' -d "$body" "$base/api/system/update/relaunch-local")
c_agent=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "X-Coral-Session-Token: not-a-token" -H 'Content-Type: application/json' -d "$body" "$base/api/system/update/relaunch-local")
if [ "$c_key" -ge 400 ] 2>/dev/null && [ "$c_agent" -ge 400 ] 2>/dev/null && [ "$(health)" = "$fromv" ] && kill -0 "$SRV0" 2>/dev/null; then
  result "4 ask" PASS "an API key ($c_key) and an agent's token ($c_agent) are refused; $fromv still the one running"
else
  result "4 ask" FAIL "key=$c_key agent=$c_agent health=[$(health)]"; finish
fi

# The apply starts the new app with /usr/bin/open, so the new Coral gets the login session's environment, not this run's HOME and data folder (#9030, found by running it): on a
# person's own Mac it would start against the real data folder. So items 5 to 8 run only on a machine that is thrown away.
if [ "$throwaway" != 1 ]; then
  result "5-8" SKIP "not run: the apply restarts Coral through open(1), outside this run's HOME and data folder; use a GitHub-hosted runner or --throwaway-machine"; finish
fi

# ---- 5 apply -----------------------------------------------------------------------------------------------
tmuxrestart=$(printf '%s' "$st" | jget relaunch.tmux_agents_restart)
answer=$(person --method POST --path /api/system/update/relaunch-local --body "$body")
deadline=$(( $(date +%s) + tmo )); v=""
while [ "$(date +%s)" -lt "$deadline" ]; do v=$(health); [ "$v" = "$tov" ] && break; sleep 3; done
SRV1=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
if [ -n "$SRV1" ] && ours "$SRV1"; then PIDS+=("$SRV1"); else [ -n "$SRV1" ] && echo "update_real: the process on :$PORT ($SRV1) after the apply is not this run's: not recorded, not killed" >&2; fi
if [ "$v" = "$tov" ] && [ -n "$SRV1" ] && [ "$SRV1" != "$SRV0" ] && ! kill -0 "$SRV0" 2>/dev/null; then
  result "5 apply" PASS "the person's request ($(printf '%s' "$answer" | head -c 80)) installed $tov: /api/health says $tov, server $SRV1 replaced $SRV0 (gone)"
else
  diag_apply
  result "5 apply" FAIL "answer=[$(printf '%s' "$answer" | head -c 300)] health=[$v] server $SRV0 then [$SRV1]; tray: $(tail -c 300 "$work/tray.out" | tr '\n' ' ')"; finish
fi

# ---- 6 install ---------------------------------------------------------------------------------------------
pv=$(/usr/bin/defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)
cs=$(codesign --verify --deep --strict "$app" 2>&1 && echo ok)
sp=$(spctl -a -t exec "$app" 2>&1 | head -1)
us=$(upd_env status --json 2>/dev/null)
inst=$(printf '%s' "$us" | jget installed)
if [ "$pv" = "$tov" ] && [ "$cs" = ok ] && printf '%s' "$sp" | grep -q accepted && [ "$inst" = "$tov" ]; then
  result "6 install" PASS "Info.plist $pv, codesign valid, spctl accepted, coral-update installed $inst"
else
  result "6 install" FAIL "plist=[$pv] codesign=[$cs] spctl=[$sp] coral-update installed=[$inst]"
fi

# ---- 7 tmux ------------------------------------------------------------------------------------------------
pane1=$(panes | head -1)
tmux_same=$([ "$(shasum -a 256 < "$oldtmux")" = "$(shasum -a 256 < "$app/Contents/MacOS/tmux")" ] && echo yes || echo no)
if [ "$pane1" = "$pane0" ]; then
  result "7 tmux" PASS "the agent's tmux session and its pane process are the same after the update [$pane1]"
elif [ -n "$pane1" ] && { [ "$tmuxrestart" = True ] || [ "$tmux_same" = no ]; }; then
  result "7 tmux" PASS "$tov bundles another tmux build (tmux_agents_restart=[$tmuxrestart]): the agent was restarted, a session is there again [$pane1] (was [$pane0])"
else
  result "7 tmux" FAIL "the session was [$pane0] and is [$pane1] (tmux_agents_restart=[$tmuxrestart], same tmux build=[$tmux_same])"
fi

# ---- 8 settled ---------------------------------------------------------------------------------------------
sleep 65   # one check a minute (429 too_soon)
person --method POST --path /api/system/update/check >/dev/null; sleep 15
st2=$(person --path /api/system/update | pbody)
if [ "$(printf '%s' "$st2" | jget not_ready_reason)" = up_to_date ] && [ "$(printf '%s' "$st2" | jget installed)" = "$tov" ]; then
  result "8 settled" PASS "a second check says up to date at $tov"
else
  result "8 settled" FAIL "status: $(printf '%s' "$st2" | head -c 400)"
fi
finish
