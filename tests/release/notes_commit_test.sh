#!/usr/bin/env bash
# tools/devops/notes-commit.sh (#8667): the notes commit carries "Gated-commit" always and "Accepted-red" only when the operator-approved suites are named, checked by release_provenance.py
# itself (a name it refuses stops the script before any commit). A throwaway git repository per case; no network.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1 # nothing here runs Coral, but the telemetry census wants it on every script that names the repository
root="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$root/tools/devops/notes-commit.sh"
fail=0
ok() { [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got '$2', want '$3')"; fail=1; }; }
BASE="$(mktemp -d /tmp/ncm.XXXX)"; case "$BASE" in /tmp/ncm.????) ;; *) echo "bad temp folder"; exit 1 ;; esac
trap 'rm -rf "$BASE"' EXIT
n=0
mkrepo() { # prints the repo's folder
  n=$((n + 1)); local d="$BASE/r$n"; mkdir -p "$d"
  ( cd "$d" && git init -q . && printf '# Release Notes\n\n## v1.0.0 — first\n\nold notes\n' > RELEASE_NOTES.md && printf '## v2.0.1 — the release\n\nnew notes\n' > notes.md \
    && git add RELEASE_NOTES.md && git -c user.name=t -c user.email=t@example.invalid commit -q -m gated ) >/dev/null 2>&1
  echo "$d"
}
run() { # repo, then the script's extra arguments: the exit status; output in $BASE/out
  local d="$1"; shift
  ( cd "$d" && bash "$SCRIPT" 2.0.1 notes.md "$(git rev-parse HEAD)" "$@" ) > "$BASE/out" 2>&1
}
msg() { git -C "$1" log -1 --format=%B; }
parsed() { # the names release_provenance reads from the commit's message
  msg "$1" | python3 -c "import sys; sys.path.insert(0, '$root/tests/release'); import release_provenance as p; g, w = p.accepted_red(sys.stdin.read()); print(g, w)"
}

d="$(mkrepo)"; run "$d"; rc=$?
ok "no names: the commit is made" "$rc" 0
ok "no names: Gated-commit is there" "$(msg "$d" | grep -c '^Gated-commit: [0-9a-f]\{40\}$')" 1
ok "no names: no Accepted-red line" "$(msg "$d" | grep -c -i 'accepted-red')" 0
ok "no names: the role identity" "$(git -C "$d" log -1 --format='%an|%ae|%cn|%ce')" "DevOps Engineer|devops-engineer@example.invalid|DevOps Engineer|devops-engineer@example.invalid"

d="$(mkrepo)"; run "$d" "strict: board_table_seeded.test.mjs"; rc=$?
ok "one suite: the commit is made" "$rc" 0
ok "one suite: the trailer is one line" "$(msg "$d" | grep -c '^Accepted-red: strict: board_table_seeded.test.mjs$')" 1
ok "one suite: release_provenance reads it" "$(parsed "$d")" "['strict: board_table_seeded.test.mjs'] None"
ok "one suite: Gated-commit is still there" "$(msg "$d" | grep -c '^Gated-commit: ')" 1

d="$(mkrepo)"; run "$d" "a.test.mjs , b.test.mjs,tmux: c.test.mjs"; rc=$?
ok "three suites with stray spaces: the commit is made" "$rc" 0
ok "three suites: normalised to ', '" "$(msg "$d" | grep '^Accepted-red:')" "Accepted-red: a.test.mjs, b.test.mjs, tmux: c.test.mjs"
ok "three suites: release_provenance reads them" "$(parsed "$d")" "['a.test.mjs', 'b.test.mjs', 'tmux: c.test.mjs'] None"

refuse() { # label, argument
  local d head
  d="$(mkrepo)"; head="$(git -C "$d" rev-parse HEAD)"
  run "$d" "$2"; local rc=$?
  ok "$1: refused" "$([ "$rc" -ne 0 ] && echo refused || echo "accepted ($rc)")" refused
  ok "$1: no commit was made" "$(git -C "$d" rev-parse HEAD)" "$head"
  ok "$1: nothing in the working tree changed" "$(git -C "$d" status --porcelain --untracked-files=no | wc -l | tr -d ' ')" 0
}
refuse "four suites" "a.test.mjs,b.test.mjs,c.test.mjs,d.test.mjs"
refuse "the same suite twice" "a.test.mjs,a.test.mjs"
refuse "a workflow command in a name" "a::error::x"
refuse "an upper-case name" "A.test.mjs"
refuse "an empty list" ""
refuse "only commas" ",,"
refuse "a second Accepted-red line smuggled in a name" $'a.test.mjs\nAccepted-red: b.test.mjs'
refuse "a go gate named" "go-tests; rm"
exit "$fail"
