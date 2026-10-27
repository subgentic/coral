#!/usr/bin/env bash
# update_real_linux.sh: the auto-update chain with REAL releases on Linux (#9192, Goal #65), the Linux twin of update_real.sh (#9030). FROM's tarball is installed in a folder of its own, run with a fresh
# HOME and data folder, and its own updater finds, verifies and stages TO on GitHub, then installs it the way a person does (Update and relaunch), with a tmux agent running through it.
#
#   tests/release/update_real_linux.sh [--from v2.0.0] [--to v2.0.1] [--check-only] [--keep] [--timeout SECONDS] [--throwaway-machine]
#
# Linux only (amd64 or arm64). FROM must be a release whose updater can apply on Linux (v1.4.167 and later). TO must be the release GitHub marks latest (the approved channel): the updater never stages
# a pre-release, so run this after the release is approved. With FROM equal to TO it is a dry run of the finding: the updater must say up to date and nothing is staged. tools/devops/update_check.md
# has the plan and what each item proves.
#
# It never runs an installed Coral and never reads ~/.coral: every program is the one in FROM's own tarball, unpacked to $work/app, started with HOME and CORAL_DATA_DIR in $work, CORAL_CLOUD_URL=off,
# CORAL_TELEMETRY_DISABLED=1 (and telemetry_enabled=false saved), a random port, and the stand-in agent CLI of smoke_macos.sh. The only network traffic is the updater's and the release downloads
# (curl from the release page): GitHub and the Sigstore TUF mirror. Every process is stopped by a pid this script recorded; the tmux server by the socket in its own data folder; the work folder by its
# own path (--keep leaves it).
#
#   1 download   FROM's tarball has the sha256 in its SHA256SUMS.txt, unpacks inside its folder and holds every program of tests/release/commands.txt
#   2 start      FROM's coral starts (FROM answers /api/health), with the tmux backend when this machine has tmux, and the stand-in agent is a tmux session
#   3 find       a check finds TO: staged, verified (Sigstore and SHA256SUMS, the updater's own), the relaunch available with its acknowledgement
#   4 ask        not the person (an API key, an agent's token) is refused and nothing starts
#   (items 5 to 8 only on a throwaway machine or a GitHub-hosted runner: see below)
#   5 apply      the person's request (signed with the data folder's command-line token) installs TO and the updater starts Coral again from its run record: the server answers TO, the old one is gone
#   6 install    coral --version is TO, coral-update says installed TO and no failed apply, and every program of the install is byte for byte the one in TO's own tarball
#   7 tmux       the agent's tmux session is the same session with the same pane process (the updater never touches the machine's tmux)
#   8 settled    a second check says up to date
#
# On Linux the updater restarts Coral from the run record the server wrote (its own command line and the allowlisted environment: HOME, CORAL_DATA_DIR), so the new Coral would come up against this run's
# folders; the apply still replaces a program folder and starts a detached process, and it stops a Coral by its pid, so items 5 to 8 run only on a machine that is thrown away (a VM, a GitHub-hosted
# runner) or with --throwaway-machine. Items 1 to 4 are safe anywhere.
#
# Output: one table; exit status 0 only when no item FAILs (a SKIP is not a failure). Needs Linux, bash, curl, python3, tar and sha256sum; go (or PERSON_CALL=/path/to/a built person-call) for items 4 to 8.
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
    -h|--help) sed -n 2,34p "$0"; exit 0 ;;
    *) echo "update_real_linux: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Linux ] || { echo "update_real_linux: Linux only (the macOS run is tests/release/update_real.sh)" >&2; exit 2; }
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "update_real_linux: amd64 and arm64 only, this is $(uname -m)" >&2; exit 2 ;; esac
for t in curl python3 tar sha256sum; do command -v "$t" >/dev/null || { echo "update_real_linux: needs $t" >&2; exit 2; }; done
fromv=${from#v} tov=${to#v}

work=$(mktemp -d /tmp/coral-upd.XXXXXX) || exit 2   # short path: tmux and pty sockets have a length limit
PIDS=()
DD="$work/d"; HH="$work/h"
app="$work/app"
cleanup() {
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  sleep 2
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  # the tmux server of this run outlives Coral on purpose: stop it by the socket of this run's own data folder
  if [ -S "$DD/tmux.sock" ] && command -v tmux >/dev/null; then tmux -S "$DD/tmux.sock" kill-server 2>/dev/null || true; fi
  if [ "$keep" = 1 ]; then echo "update_real_linux: kept $work"; else case "$work" in /tmp/coral-upd.??????) rm -rf -- "$work" ;; esac; fi
}
trap cleanup EXIT

NAMES=() STATES=() DETAILS=()
result() { NAMES+=("$1"); STATES+=("$2"); DETAILS+=("$3"); [ "$2" = PASS ] || echo "update_real_linux: $2 $1: $3" >&2; }
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
# the pid of the process listening on 127.0.0.1:$1 (/proc only: no lsof or ss needed), "" when none
listener_pid() {
  python3 - "$1" <<'PY'
import os, sys
port = int(sys.argv[1]); inodes = set()
for f in ("/proc/net/tcp", "/proc/net/tcp6"):
    try: lines = open(f).read().splitlines()[1:]
    except OSError: continue
    for l in lines:
        p = l.split()
        if p[3] == "0A" and int(p[1].split(":")[1], 16) == port: inodes.add(p[9])
for pid in sorted((d for d in os.listdir("/proc") if d.isdigit()), key=int):
    try:
        for fd in os.listdir("/proc/%s/fd" % pid):
            try: t = os.readlink("/proc/%s/fd/%s" % (pid, fd))
            except OSError: continue
            if t.startswith("socket:[") and t[8:-1] in inodes: print(pid); sys.exit(0)
    except OSError: continue
PY
}
# a pid is recorded for kill only when its program is a file of this run's work folder (a port reused by another process is never killed)
ours() { local p=$1 exe; [ -n "$p" ] || return 1; exe=$(readlink "/proc/$p/exe" 2>/dev/null); case "$exe" in "$work"/*) return 0 ;; *) return 1 ;; esac; }

# ---- 1 download --------------------------------------------------------------------------------------------
mkdir -p "$work/dl" "$work/dl2" "$app" "$work/wd" "$HH/.coral" "$HH/.claude/projects" "$DD" "$work/bin"
fromhome=$(release_home_for_tag "$from"); tohome=$(release_home_for_tag "$to")
asset() { echo "coral-linux-$arch-${1#v}.tar.gz"; }
fetch() { curl -fsSL -m 600 --retry 2 -o "$3" "https://github.com/$1/releases/download/$2"; }   # fetch HOME TAG/FILE DEST
if ! fetch "$fromhome" "$from/$(asset "$from")" "$work/dl/$(asset "$from")" || ! fetch "$fromhome" "$from/SHA256SUMS.txt" "$work/dl/SHA256SUMS.txt"; then
  result "1 download" FAIL "could not download $(asset "$from") and SHA256SUMS.txt of $from from $fromhome"; finish
fi
tgz="$work/dl/$(asset "$from")"
want=$(grep -E " \*?$(basename "$tgz")\$" "$work/dl/SHA256SUMS.txt" | head -1 | cut -d' ' -f1)
got=$(sha256sum "$tgz" | cut -d' ' -f1)
if [ -z "$want" ] || [ "$want" != "$got" ]; then result "1 download" FAIL "sha256 of $(basename "$tgz") is $got, SHA256SUMS.txt says [$want]"; finish; fi
bad=$(tar -tzf "$tgz" 2>/dev/null | grep -E '(^/|(^|/)\.\.(/|$))' | head -1)
if [ -n "$bad" ] || ! tar -xzf "$tgz" -C "$app" 2>/dev/null; then result "1 download" FAIL "the tarball does not unpack inside its folder (${bad:-tar failed})"; finish; fi
cmds=$(grep -vE '^[[:space:]]*(#|$)' "$here/commands.txt"); missing=""
for c in $cmds; do [ -f "$app/$c" ] && [ -x "$app/$c" ] || missing="$missing $c"; done
if [ -n "$missing" ]; then result "1 download" FAIL "programs missing or not executable:$missing"; finish; fi
result "1 download" PASS "$(basename "$tgz") is the sha256 of SHA256SUMS.txt ($(printf %.12s "$got")); $(echo $cmds | wc -w | tr -d ' ') programs present"

# the stand-in for the person at this computer (a request signed with the data folder's command-line token), built from this tree or given
if [ -n "${PERSON_CALL:-}" ] && [ -x "$PERSON_CALL" ]; then cp "$PERSON_CALL" "$work/bin/person-call"
elif ! command -v go >/dev/null || ! (cd "$root/coral-go" && CGO_ENABLED=0 go build -o "$work/bin/person-call" ./internal/updater/testrig/cmd/person-call) 2>"$work/pc.txt"; then
  result "2 start" FAIL "no person-call: PERSON_CALL is not set and go could not build it: $(head -c 200 "$work/pc.txt" 2>/dev/null)"; finish
fi

# ---- 2 start -----------------------------------------------------------------------------------------------
echo accepted > "$HH/.coral/.eula-accepted"
PORT=$(free_port)
backend=pty; command -v tmux >/dev/null && backend=tmux
env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HH" CORAL_DATA_DIR="$DD" CORAL_CLOUD_URL=off CORAL_TELEMETRY_DISABLED=1 CORAL_NO_DEMO_SEED=1 \
  "$app/coral" --home "$DD" --host 127.0.0.1 --port "$PORT" --backend "$backend" --no-browser --cloud-url off > "$work/server.out" 2>&1 & SRV0=$!
PIDS+=("$SRV0"); disown "$SRV0"
for i in $(seq 1 150); do curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; kill -0 "$SRV0" 2>/dev/null || break; sleep 0.4; done
for i in $(seq 1 80); do [ -r "$DD/api_key" ] && break; sleep 0.5; done
KEY=$(tr -d '[:space:]' < "$DD/api_key" 2>/dev/null)
base="http://127.0.0.1:$PORT"
api() { curl -s -m 30 -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }
person() { env -i HOME="$HH" PATH=/usr/bin:/bin "$work/bin/person-call" --data-dir "$DD" --url "$base" "$@"; }   # prints "CODE body"
pbody() { sed 's/^[0-9]* //'; }
health() { curl -s -m 5 "$base/api/health" | jget version; }
upd_env() { env -i HOME="$HH" PATH=/usr/bin:/bin CORAL_DATA_DIR="$DD" CORAL_CLOUD_URL=off CORAL_TELEMETRY_DISABLED=1 "$app/coral-update" "$@"; }
if [ -z "$KEY" ] || [ "$(health)" != "$fromv" ]; then
  result "2 start" FAIL "key=[${KEY:+set}] health=[$(health)] want $fromv; server: $(tail -c 300 "$work/server.out" | tr '\n' ' ')"; finish
fi
api -X PUT -d "{\"cli_path_claude\":\"$here/smoke_macos/standin_cli.py\",\"telemetry_enabled\":false}" "$base/api/settings" >/dev/null
launch=$(api -X POST -d "{\"working_dir\":\"$work/wd\",\"display_name\":\"survivor\"}" "$base/api/sessions/launch")
terminal=$(printf '%s' "$launch" | jget terminal)
sleep 4
panes() { command -v tmux >/dev/null && tmux -S "$DD/tmux.sock" list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null; }
pane0=$(panes | head -1)
if [ "$backend" = tmux ] && [ "$terminal" = tmux ] && [ -n "$pane0" ]; then
  result "2 start" PASS "$fromv answers /api/health on :$PORT (server $SRV0, tmux backend); the stand-in agent is the tmux session [$pane0]"
elif [ "$backend" = pty ] && [ -n "$(printf '%s' "$launch" | jget session_name)" ]; then
  result "2 start" PASS "$fromv answers /api/health on :$PORT (server $SRV0, pty backend: this machine has no tmux); the stand-in agent started"
else
  result "2 start" FAIL "backend=$backend launch=[$(printf '%s' "$launch" | head -c 200)] terminal=[$terminal] panes=[$pane0]"; finish
fi

# ---- 3 find ------------------------------------------------------------------------------------------------
# Evidence for a check that failed (#9075): what the updater logged for it, and the GitHub rate limit it ran under. The updater asks GitHub without a token (60 requests an hour per address,
# shared by every run on the same address); a 403 with x-ratelimit-remaining 0 is that limit, not a Coral fault.
diag_failure() {
  echo "update_real_linux: ---- evidence for the failed check ----" >&2
  echo "update_real_linux: the updater's own status (coral-update status):" >&2
  upd_env status 2>&1 | head -30 | sed 's/^/    /' >&2
  echo "update_real_linux: the server's [update] log lines (stage and HTTP status are in them):" >&2
  { grep -h '\[update\]' "$work/server.out" 2>/dev/null; grep -hr '\[update\]' "$DD"/*.log "$HH"/.coral/*.log 2>/dev/null; } | tail -20 | sed 's/^/    /' >&2
  echo "update_real_linux: GitHub's rate limit as the updater sees it (unauthenticated):" >&2
  curl -s -m 15 -D - -o /dev/null https://api.github.com/rate_limit 2>/dev/null | tr -d '\r' | grep -iE '^(HTTP/|x-ratelimit-(limit|remaining|reset|resource)|retry-after)' | sed 's/^/    /' >&2
  echo "update_real_linux: ---- end of the evidence ----" >&2
}
checked_at() { person --path /api/system/update | pbody | jget checked_at; }
start_check() { person --method POST --path /api/system/update/check | grep -q '^202'; }
before=$(checked_at)
start_check || { result "3 find" FAIL "the check was not accepted: $(person --method POST --path /api/system/update/check)"; finish; }
st=""; deadline=$(( $(date +%s) + tmo )); retried=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # the status is read only once the check is over: checked_at changes when it ends
  now=$(checked_at)
  if [ -z "$now" ] || [ "$now" = "$before" ]; then sleep 3; continue; fi
  st=$(person --path /api/system/update | pbody)
  reason=$(printf '%s' "$st" | jget not_ready_reason)
  if [ "$reason" = backoff ] || [ "$reason" = check_failed ]; then
    echo "update_real_linux: the updater says $reason after the check at $now" >&2
    diag_failure
    if [ "$retried" = 0 ]; then
      retried=1; echo "update_real_linux: retrying the check once after 65 s (one check a minute; a failure backs the next one off, up to a day)" >&2
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
c_key=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d "$body" "$base/api/system/update/relaunch-local")
c_agent=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST -H "X-Coral-Session-Token: not-a-token" -H 'Content-Type: application/json' -d "$body" "$base/api/system/update/relaunch-local")
if [ "$c_key" -ge 400 ] 2>/dev/null && [ "$c_agent" -ge 400 ] 2>/dev/null && [ "$(health)" = "$fromv" ] && kill -0 "$SRV0" 2>/dev/null; then
  result "4 ask" PASS "an API key ($c_key) and an agent's token ($c_agent) are refused; $fromv still the one running"
else
  result "4 ask" FAIL "key=$c_key agent=$c_agent health=[$(health)]"; finish
fi

# The apply replaces the program folder and starts Coral again from the run record: items 5 to 8 run only on a machine that is thrown away.
if [ "$throwaway" != 1 ]; then
  result "5-8" SKIP "not run: the apply replaces a program folder and restarts Coral from its run record; use a throwaway machine (--throwaway-machine) or a GitHub-hosted runner"; finish
fi

# ---- 5 apply -----------------------------------------------------------------------------------------------
answer=$(person --method POST --path /api/system/update/relaunch-local --body "$body")
deadline=$(( $(date +%s) + tmo )); v=""
while [ "$(date +%s)" -lt "$deadline" ]; do v=$(health); [ "$v" = "$tov" ] && break; sleep 3; done
SRV1=$(listener_pid "$PORT")
if [ -n "$SRV1" ] && ours "$SRV1"; then PIDS+=("$SRV1"); else [ -n "$SRV1" ] && echo "update_real_linux: the process on :$PORT ($SRV1) after the apply is not this run's: not recorded, not killed" >&2; fi
if [ "$v" = "$tov" ] && [ -n "$SRV1" ] && [ "$SRV1" != "$SRV0" ] && ! kill -0 "$SRV0" 2>/dev/null; then
  result "5 apply" PASS "the person's request ($(printf '%s' "$answer" | head -c 80)) installed $tov: /api/health says $tov, server $SRV1 replaced $SRV0 (gone)"
else
  result "5 apply" FAIL "answer=[$(printf '%s' "$answer" | head -c 300)] health=[$v] server $SRV0 then [$SRV1]; server log: $(tail -c 300 "$work/server.out" | tr '\n' ' ')"; finish
fi

# ---- 6 install ---------------------------------------------------------------------------------------------
pv=$(env -i HOME="$HH" PATH=/usr/bin:/bin "$app/coral" --version 2>&1 | head -1)
us=$(upd_env status --json 2>/dev/null)
inst=$(printf '%s' "$us" | jget installed)
mismatch=""
if fetch "$tohome" "$to/$(asset "$to")" "$work/dl2/$(asset "$to")" && mkdir -p "$work/to" && tar -xzf "$work/dl2/$(asset "$to")" -C "$work/to" 2>/dev/null; then
  for c in $cmds; do cmp -s "$app/$c" "$work/to/$c" || mismatch="$mismatch $c"; done
else mismatch=" (could not download or unpack $to's tarball to compare)"; fi
if printf '%s' "$pv" | grep -qF -- "$tov" && [ "$inst" = "$tov" ] && [ -z "$mismatch" ]; then
  result "6 install" PASS "coral --version [$pv], coral-update installed $inst, every program is byte for byte $to's own"
else
  result "6 install" FAIL "version=[$pv] coral-update installed=[$inst] differing programs:[$mismatch]"
fi

# ---- 7 tmux ------------------------------------------------------------------------------------------------
pane1=$(panes | head -1)
if [ "$backend" != tmux ]; then
  result "7 tmux" SKIP "this machine has no tmux: the pty backend's agents do not outlive Coral"
elif [ "$pane1" = "$pane0" ]; then
  result "7 tmux" PASS "the agent's tmux session and its pane process are the same after the update [$pane1]"
else
  result "7 tmux" FAIL "the session was [$pane0] and is [$pane1]"
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
