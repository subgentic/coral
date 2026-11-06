#!/usr/bin/env bash
# pin_check_test.sh: tools/devops/pin-check.sh fails release prep when the previous plain release has no digest row, and never writes a file (#13779).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/../../tools/devops/pin-check.sh"
fails=0
fail() { echo "FAIL: $*" >&2; fails=$((fails+1)); }

work="$(mktemp -d "${TMPDIR:-/tmp}/pin-check-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
mkdir -p "$repo/coral-go/internal/machinelaunch"
git -C "$repo" init -q
git -C "$repo" config user.email t@example.invalid; git -C "$repo" config user.name t
cat > "$repo/coral-go/internal/machinelaunch/releases.go" <<'GO'
var releaseDigests = map[string]ReleaseDigests{
	// 2.0.9: x
	"2.0.9": {
		AMD64: "a",
	},
	"2.0.10": {
		AMD64: "a",
	},
}
GO
git -C "$repo" add -A; git -C "$repo" commit -q -m t
for t in v2.0.9 v2.0.10 v2.0.11-rc1 v2.0.11-dev; do git -C "$repo" tag "$t"; done

before="$(cd "$repo" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum | shasum)"

# previous plain tag is 2.0.10 (numeric order, not 2.0.9; -rc and -dev tags are ignored): it is pinned
out="$("$script" 2.0.11 "$repo" 2>&1)"; rc=$?
[ "$rc" = 0 ] || fail "2.0.11 with 2.0.10 pinned: want exit 0, got $rc: $out"
case "$out" in *"v2.0.10 is pinned"*) ;; *) fail "the pinned message does not name v2.0.10: $out" ;; esac

# a new plain tag with no row: exit 1 and the exact command
git -C "$repo" tag v2.0.11
out="$("$script" 2.0.12 "$repo" 2>&1)"; rc=$?
[ "$rc" = 1 ] || fail "2.0.12 with 2.0.11 unpinned: want exit 1, got $rc: $out"
case "$out" in *"tools/pin-release-digests.sh 2.0.11"*) ;; *) fail "the failure does not print the pin command for 2.0.11: $out" ;; esac

# bad usage and a broken tree: exit 2
"$script" 2.0 "$repo" >/dev/null 2>&1; [ "$?" = 2 ] || fail "a bad version must exit 2"
"$script" 2.0.12 "$work/nowhere" >/dev/null 2>&1; [ "$?" = 2 ] || fail "a missing tree must exit 2"

after="$(cd "$repo" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 shasum | shasum)"
[ "$before" = "$after" ] || fail "the check changed a file in the tree"

[ "$fails" = 0 ] && echo "PASS pin-check" || { echo "$fails failure(s)" >&2; exit 1; }
