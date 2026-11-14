#!/usr/bin/env bash
# tools/devops/new-routes.sh --diff (#16727): the comparison of two route dumps lists NEW routes and CHANGED tiers, and says "none" for an empty group. No git, no Go, no network.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1 # nothing here runs Coral, but the telemetry census wants it on every script that names the repository
root="$(cd "$(dirname "$0")/../.." && pwd)"
S="$root/tools/devops/new-routes.sh"
fail=0
ok() { [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got '$2', want '$3')"; fail=1; }; }
D="$(mktemp -d /tmp/nrt.XXXX)"; case "$D" in /tmp/nrt.????) ;; *) echo "bad temp folder"; exit 1 ;; esac
trap 'rm -rf "$D"' EXIT
printf 'GET\t/api/a\tview\tfalse\tfalse\nPUT\t/api/b\tinteract\tfalse\tfalse\n' > "$D/p.tsv"
printf 'GET\t/api/a\tview\tfalse\tfalse\nPUT\t/api/b\tlaunch\tfalse\tfalse\nGET\t/api/c\tview\ttrue\tfalse\nPUT\t/api/c\tlaunch\ttrue\tfalse\n' > "$D/n.tsv"
out="$(bash "$S" --diff "$D/p.tsv" "$D/n.tsv")"
ok "a new route is listed with its tier and owner rule" "$(grep -c '^- GET /api/c: view, owner-refused$' <<<"$out")" 1
ok "a second method of a new path is its own row" "$(grep -c '^- PUT /api/c: launch, owner-refused$' <<<"$out")" 1
ok "a changed tier is listed as changed" "$(grep -c '^- PUT /api/b: interact -> launch, not owner-refused$' <<<"$out")" 1
ok "an unchanged route is not listed" "$(grep -c '/api/a' <<<"$out")" 0
out2="$(bash "$S" --diff "$D/n.tsv" "$D/n.tsv")"
ok "nothing new says none three times" "$(grep -c '^none$' <<<"$out2")" 3
ok "a bad call is refused" "$(bash "$S" --diff "$D/nope" "$D/n.tsv" >/dev/null 2>&1; echo $?)" 2
exit "$fail"
