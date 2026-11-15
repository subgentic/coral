#!/bin/sh
# cpu_load.sh N [SECONDS [OWNER_PID]]: N busy loops for reproducing a flaky test under CPU load (#18213).
#
#   pids=$(tests/stress/cpu_load.sh 8 900 $$)  # 8 loops, at most 15 minutes, owned by this shell; prints their PIDs
#   kill $pids                                  # optional: stop them early
#
# Every loop stops by itself: when OWNER_PID is gone (default: the script's parent, so pass $$ when it runs
# inside $( ), whose subshell ends at once; checked every second) and after SECONDS at most (default 600). A timeout or a killed tool shell used to orphan the
# old `( while :; do :; done ) &` loops for a day; these end within about a second of their owner, whatever
# way it ended (even SIGKILL). Run it as one step of the same command as the test, not from a shell that
# outlives the work. A loop killed early takes its watcher with it (within a second), so the watcher never
# signals a PID that was reused. Output is the PIDs, one line; the loops write nothing.
usage() { echo "usage: cpu_load.sh N [SECONDS [OWNER_PID]]  (N 1-64, SECONDS 1-86400)" >&2; exit 2; }
n=${1:-}; secs=${2:-600}; owner=${3:-$PPID}
case "$n$secs$owner" in *[!0-9]*) usage ;; esac
[ -n "$n" ] && [ "$n" -ge 1 ] && [ "$n" -le 64 ] && [ "$secs" -ge 1 ] && [ "$secs" -le 86400 ] || usage
pids=""; i=0
while [ "$i" -lt "$n" ]; do
  ( while :; do :; done ) >/dev/null 2>&1 &
  busy=$!
  ( t=0; while kill -0 "$owner" 2>/dev/null && kill -0 "$busy" 2>/dev/null && [ "$t" -lt "$secs" ]; do sleep 1; t=$((t + 1)); done; kill -0 "$busy" 2>/dev/null && kill "$busy" 2>/dev/null ) >/dev/null 2>&1 &
  pids="$pids $busy"; i=$((i + 1))
done
echo $pids
