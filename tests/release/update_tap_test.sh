#!/usr/bin/env bash
# tools/devops/update-tap.sh against a local bare repository standing in for the Homebrew tap (release channels, #5559): no network.
# The cask is a fixed input to these version/URL rewrite cases, not the current
# shipped cask: changing that config must not silently change the fake tap.
# A separate integration case below intentionally checks the current real cask.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1 # nothing here runs Coral, but the telemetry census wants it on every script that names the repository
here="$(cd "$(dirname "$0")" && pwd)"; SCRIPT="$here/../../tools/devops/update-tap.sh"; CASK="$here/fixtures/update-tap-coral.rb"
T="$(mktemp -d /tmp/utp.XXXX)"; [ -d "$T" ] || exit 1
trap 'rm -rf "$T"' EXIT
fail=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1" >&2; fail=1; }
ID=(-c user.name=t -c user.email=t@example.invalid)
S1=$(printf '1%.0s' $(seq 64)); S2=$(printf '2%.0s' $(seq 64)); S3=$(printf '3%.0s' $(seq 64))
export GITHUB_REPOSITORY=subgentic/coral

mktap() {  # mktap VERSION [REAL_CASK]: fixed fixture at VERSION, or an unchanged real copy
  rm -rf "$T/bare.git" "$T/seed"; git init -q --bare -b main "$T/bare.git"; git init -q -b main "$T/seed"
  mkdir -p "$T/seed/Casks"
  if [ "$#" -gt 1 ]; then
    cp "$2" "$T/seed/Casks/coral.rb"
  else
    sed -E "s/^  version \"[^\"]*\"$/  version \"$1\"/" "$CASK" > "$T/seed/Casks/coral.rb"
  fi
  (cd "$T/seed" && git add -A && git "${ID[@]}" commit -qm "coral $1" && git push -q "$T/bare.git" HEAD:main)
}
cask() { git --git-dir="$T/bare.git" show main:Casks/coral.rb; }
commits() { git --git-dir="$T/bare.git" rev-list --count main; }
run() { TAP_URL="file://$T/bare.git" bash "$SCRIPT" "$@" 2>&1; }

mktap 1.4.149
out="$(run 1.4.150 "$S1")"; rc=$?
[ $rc = 0 ] && cask | grep -qx '  version "1.4.150"' && cask | grep -qx "  sha256 \"$S1\"" && ok "approve: version and sha256 are set" || bad "approve: $out"
cask | grep -qx '  url "https://github.com/subgentic/coral/releases/download/v#{version}/Coral.v#{version}.dmg"' && cask | grep -qx '  homepage "https://github.com/subgentic/coral"' && ok "approve: url and homepage follow the repository that built the release" || bad "approve: url/homepage"
[ "$(commits)" = 2 ] && [ "$(git --git-dir="$T/bare.git" log -1 --format=%an main)" = coral-release ] && ok "approve: exactly one new commit by the release identity" || bad "approve: commits=$(commits)"
before="$(commits)"; out="$(run 1.4.150 "$S1")"; rc=$?
[ $rc = 0 ] && [ "$(commits)" = "$before" ] && ok "approve again: nothing to do, no commit" || bad "approve again: $out"
out="$(run 1.4.149 "$S2")"; rc=$?
[ $rc = 0 ] && [ "$(commits)" = "$before" ] && cask | grep -qx '  version "1.4.150"' && ok "approve of an older version never downgrades the cask" || bad "downgrade guard: $out"
out="$(run 1.4.9 "$S2")"; [ "$(commits)" = "$before" ] && ok "1.4.9 is older than 1.4.150 (numeric compare)" || bad "numeric compare: $out"

# revoke: the cask goes back by a NEW commit, never by a force-push
out="$(run 1.4.149 "$S3" --revoke)"; rc=$?
[ $rc = 0 ] && cask | grep -qx '  version "1.4.149"' && cask | grep -qx "  sha256 \"$S3\"" && [ "$(commits)" = $((before+1)) ] && ok "revoke: a new commit puts the previous version back" || bad "revoke: $out"
git --git-dir="$T/bare.git" log -1 --format=%s main | grep -q 'revoke' && ok "revoke: the commit message says so" || bad "revoke message"
out="$(run 1.4.150 "$S1" --revoke)"; rc=$?
[ $rc != 0 ] && grep -q 'not older' <<<"$out" && ok "revoke towards a NEWER version is refused" || bad "revoke newer: rc=$rc $out"

# bad input never reaches git
UP=$(printf 'A%.0s' $(seq 64))
for args in "v1.4.150 $S1" "1.4 $S1" "1.4.150-rc1 $S1" "1.4.150 abc" "1.4.150 $UP"; do
  # shellcheck disable=SC2086
  out="$(run $args)"; rc=$?; [ $rc != 0 ] && ok "refused: $args" || bad "accepted: $args"
done
out="$(run 1.4.150 "$S1" --force)"; [ $? != 0 ] && ok "an unknown flag is refused" || bad "unknown flag accepted"
# Intentional live cask contract: unit cases above keep fixed inputs, while this
# case catches drift in the actual shipped file. It never installs or publishes it.
real_cask="$here/../../Casks/coral.rb"
real_version="$(sed -nE 's/^  version "([^"]*)"$/\1/p' "$real_cask")"
real_next="${real_version%.*}.$((${real_version##*.} + 1))"
mktap "$real_version" "$real_cask"
cmp -s "$real_cask" "$T/seed/Casks/coral.rb" || bad "real cask: the seed must be an unchanged copy"
out="$(GITHUB_REPOSITORY=example/coral run "$real_next" "$S2")"; rc=$?
if [ "$rc" != 0 ]; then
  bad "real cask: rewrite failed: $out"
else
  cask > "$T/real-after.rb"
  python3 - "$real_cask" "$T/real-after.rb" "$real_next" "$S2" <<'PYTHON'
import pathlib
import re
import sys
before, after = [pathlib.Path(p).read_text().splitlines(keepends=True) for p in sys.argv[1:3]]
expected = {
    "version": '  version "' + sys.argv[3] + '"\n',
    "sha256": '  sha256 "' + sys.argv[4] + '"\n',
    "url": '  url "https://github.com/example/coral/releases/download/v#{version}/Coral.v#{version}.dmg"\n',
    "homepage": '  homepage "https://github.com/example/coral"\n',
}
assert len(before) == len(after), "real cask: rewrite added or removed lines"
positions = set()
for field, line in expected.items():
    matches = [i for i, text in enumerate(before) if re.fullmatch(r'  ' + field + r' "[^"\n]*"\n?', text)]
    assert len(matches) == 1, f"real cask: expected one {field} line"
    i = matches[0]
    positions.add(i)
    assert after[i] == line, f"real cask: {field} did not get its expected value"
changed = {i for i, (old, new) in enumerate(zip(before, after)) if old != new}
assert changed == positions, "real cask: only version, sha256, url and homepage may change"
PYTHON
  [ "$?" = 0 ] && ok "real cask: exactly four fields change, every other line is preserved" || bad "real cask: unexpected rewrite"
fi
exit "$fail"
