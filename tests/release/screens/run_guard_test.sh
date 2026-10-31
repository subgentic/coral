#!/usr/bin/env bash
# The work-folder guard of run.sh (Security's #11216 INFO): the neutral folder and its lock are made 0700 by this run, and a path that is a link, not ours or not 0700 is refused. The block is taken from run.sh
# itself (from "NEUTRAL=" to the line before "WORK=") and run against a temp path.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/screens-guard.XXXXXX")"
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
sed -n '/^NEUTRAL=/,/^WORK=/p' "$HERE/run.sh" | sed '$d' > "$T/block.sh"
[ -s "$T/block.sh" ] || { echo "FAIL: could not take the guard out of run.sh"; exit 1; }
fail=0
run() { # name, expected exit (0 or 3), setup...
    local name="$1" want="$2"; shift 2
    local N="$T/case-$$-$RANDOM"; rm -rf "$N" "$N.lock"
    ( "$@" "$N" )
    local got
    got="$( cd "$T" && bash -c "NEUTRAL='$N'; exit_code=0; $(sed 's#^NEUTRAL=.*#:#' "$T/block.sh")" >/dev/null 2>&1; echo $? )"
    if [ "$got" = "$want" ]; then echo "ok   $name (exit $got)"; else echo "FAIL $name: exit $got, wanted $want"; fail=1; fi
    if [ "$want" = 0 ]; then [ "$(stat -c %a "$N" 2>/dev/null || stat -f %Lp "$N")" = 700 ] || { echo "FAIL $name: folder is not 0700"; fail=1; }; fi
}
none()      { :; }
mode755()   { mkdir "$1"; chmod 755 "$1"; }
mode700()   { mkdir "$1"; chmod 700 "$1"; echo old > "$1/file"; }
link()      { mkdir "$1.target"; ln -s "$1.target" "$1"; }
lockheld()  { mkdir "$1.lock"; }
lockmode()  { mkdir "$1.lock"; chmod 755 "$1.lock"; rmdir "$1.lock"; ln -s "$T" "$1.lock"; }
run "a clean start makes a private folder"            0 none
run "an own 0700 folder is cleared and used"           0 mode700
run "a folder with mode 0755 is refused"               3 mode755
run "a link in its place is refused"                   3 link
run "a lock held by another run is refused"            3 lockheld
run "a link in place of the lock is refused"           3 lockmode
exit $fail
