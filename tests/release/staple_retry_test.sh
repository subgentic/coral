#!/usr/bin/env bash
# staple_retry_test.sh: the macOS staple's retry (#12721) and the guards around it in release.yml. A stand-in xcrun, no network, no waits.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/staple-retry-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { echo "ok: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }

mkdir -p "$tmp/bin"
cat >"$tmp/bin/xcrun" <<'SH'
#!/usr/bin/env bash
# xcrun stapler staple|validate PATH: STUB_STAPLE_FAILS counts how many staple calls fail before one works; STUB_VALIDATE_FAIL=1 makes validate fail; STUB_VALIDATE_FAILS counts how many validate calls fail before one works.
echo "$2 $3" >>"$STUB_LOG"
if [ "$2" = staple ]; then
  n=$(grep -c '^staple ' "$STUB_LOG"); [ "$n" -gt "${STUB_STAPLE_FAILS:-0}" ] || exit 1
fi
if [ "$2" = validate ] && [ "${STUB_VALIDATE_FAIL:-}" = 1 ]; then exit 1; fi
if [ "$2" = validate ] && [ -n "${STUB_VALIDATE_FAILS:-}" ]; then n=$(grep -c '^validate ' "$STUB_LOG"); [ "$n" -gt "$STUB_VALIDATE_FAILS" ] || exit 1; fi
exit 0
SH
chmod 755 "$tmp/bin/xcrun"
export PATH="$tmp/bin:$PATH" STAPLE_WAIT=0 STAPLE_TRIES=5 VALIDATE_WAIT=0
# shellcheck source=/dev/null
source "$root/tests/release/staple_retry.sh"
count() { grep -c "^$1 " "$STUB_LOG" || true; }
run() { : >"$STUB_LOG"; local rc=0; ( "$@" ) >/dev/null 2>&1 || rc=$?; echo "$rc"; }
export STUB_LOG="$tmp/log"

# a first try that works: one staple, one validate, return 0
export STUB_STAPLE_FAILS=0 STUB_VALIDATE_FAIL=0; rc=$(run staple_retry x.app); [ "$rc" = 0 ] && [ "$(count staple)" = 1 ] && [ "$(count validate)" = 1 ] && ok "a first try that works stapled once" || fail "first try: rc=$rc staples=$(count staple)"
# two failures, then a success: three staples, return 0
export STUB_STAPLE_FAILS=2 STUB_VALIDATE_FAIL=0; rc=$(run staple_retry x.app); [ "$rc" = 0 ] && [ "$(count staple)" = 3 ] && ok "two failures and a success tried three times" || fail "retry: rc=$rc staples=$(count staple)"
# every try fails: exactly STAPLE_TRIES staples (the first four are warned about), return 1
export STUB_STAPLE_FAILS=99 STUB_VALIDATE_FAIL=0; rc=$(run staple_retry x.app); [ "$rc" = 1 ] && [ "$(count staple)" = 5 ] && ok "five failures give up after five tries and return 1" || fail "give up: rc=$rc staples=$(count staple)"
# a staple that works but a validate that does not is a failed try, not a success
export STUB_STAPLE_FAILS=0 STUB_VALIDATE_FAIL=1; rc=$(run staple_retry x.app); [ "$rc" = 1 ] && [ "$(count staple)" = 5 ] && ok "a staple that does not validate is retried and then fails" || fail "validate: rc=$rc staples=$(count staple)"
# unstapled says so, sets ONE flag for the artifact named and writes the job summary
export GITHUB_ENV="$tmp/env" GITHUB_STEP_SUMMARY="$tmp/summary"; : >"$GITHUB_ENV"; : >"$GITHUB_STEP_SUMMARY"
out="$(unstapled UNSTAPLED_APP "Coral.app")"; grep -q "^::warning::Coral.app is notarized" <<<"$out" && grep -qx "UNSTAPLED_APP=1" "$GITHUB_ENV" && ! grep -q "UNSTAPLED_DMG" "$GITHUB_ENV" && grep -q "Coral.app shipped notarized but not stapled" "$GITHUB_STEP_SUMMARY" && ok "unstapled warns, sets only its own flag and writes the summary" || fail "unstapled: $out / $(cat "$GITHUB_ENV") / $(cat "$GITHUB_STEP_SUMMARY")"

# the marker: one word per unstapled artifact in dist/unstapled.txt, none when nothing is unstapled, nothing for an unknown flag
mk="$tmp/dist"; mkdir -p "$mk"; export STAPLE_MARKER_DIR="$mk"
[ ! -e "$mk/unstapled.txt" ] && ok "no marker file while nothing is unstapled" || fail "a marker exists with nothing unstapled"
unstapled UNSTAPLED_DMG "Coral.vX.dmg" >/dev/null; [ "$(cat "$mk/unstapled.txt")" = dmg ] && ok "an unstapled DMG is recorded as 'dmg'" || fail "marker after the DMG: $(cat "$mk/unstapled.txt" 2>/dev/null)"
unstapled UNSTAPLED_APP "Coral.app" >/dev/null; [ "$(tr '\n' ' ' <"$mk/unstapled.txt")" = "dmg app " ] && ok "an unstapled app is added as 'app'" || fail "marker after the app: $(tr '\n' ' ' <"$mk/unstapled.txt")"
unstapled SOMETHING_ELSE "x" >/dev/null; [ "$(wc -l <"$mk/unstapled.txt" | tr -d ' ')" = 2 ] && ok "an unknown flag adds nothing to the marker" || fail "marker grew for an unknown flag"
unset STAPLE_MARKER_DIR
# the marker's route: uploaded only when it exists, read only by verify-release.sh --allow-unstapled, which finish-release.sh always passes
vr="$root/tools/verify-release.sh"; fr="$root/tools/devops/finish-release.sh"
grep -q "hashFiles('dist/unstapled.txt')" "$root/.github/workflows/release.yml" && grep -q "name: coral-macos-unstapled" "$root/.github/workflows/release.yml" && ok "release.yml uploads coral-macos-unstapled only when the marker file exists" || fail "release.yml does not upload the marker conditionally"
grep -q -- "--allow-unstapled) ALLOW_UNSTAPLED=1" "$vr" && grep -q "coral-macos-unstapled" "$vr" && ok "verify-release.sh reads the marker behind --allow-unstapled" || fail "verify-release.sh does not read the marker"
grep -q -- "--allow-unstapled" "$fr" && ok "finish-release.sh passes --allow-unstapled" || fail "finish-release.sh does not pass the flag"

# the workflow's guards, by text: an Accepted check comes before each unstapled path, and the verify step skips spctl and validate when unstapled
wf="$root/.github/workflows/release.yml"
a=$(grep -n 'status: Accepted' "$wf" | head -1 | cut -d: -f1 || true); s1=$(grep -n 'staple_retry dist/Coral.app' "$wf" | head -1 | cut -d: -f1 || true)
[ -n "$a" ] && [ -n "$s1" ] && [ "$a" -lt "$s1" ] && ok "the app's Accepted check comes before its staple" || fail "app: accepted line $a, staple line $s1"
b=$(grep -n '"$STATUS" = "Accepted"' "$wf" | head -1 | cut -d: -f1 || true); s2=$(grep -n 'staple_retry "dist/$DMG_NAME"' "$wf" | head -1 | cut -d: -f1 || true)
[ -n "$b" ] && [ -n "$s2" ] && [ "$b" -lt "$s2" ] && ok "the DMG's Accepted check comes before its staple" || fail "dmg: accepted line $b, staple line $s2"
[ "$(grep -c 'UNSTAPLED_DMG:-}" != 1' "$wf" || true)" = 1 ] && [ "$(grep -c 'UNSTAPLED_APP:-}" != 1' "$wf" || true)" = 1 ] && ok "the verify step guards each artifact's spctl and stapler validate by its own flag" || fail "verify guards: dmg $(grep -c 'UNSTAPLED_DMG:-}" != 1' "$wf" || true), app $(grep -c 'UNSTAPLED_APP:-}" != 1' "$wf" || true)"
if grep -nE '^[[:space:]]*xcrun stapler (staple|validate) ' "$wf" | grep -v "staple_retry" | grep -q "stapler staple"; then fail "a bare 'stapler staple' is still in release.yml"; else ok "no bare stapler staple is left in release.yml"; fi
# validate_retry (#13568): the verify step's `stapler validate` is tried a few times, because Apple's ticket service (CloudKit) answers "The network connection was lost" (error 68) after an accepted notarization
unset STUB_STAPLE_FAILS STUB_VALIDATE_FAIL
export STUB_VALIDATE_FAILS=0; rc=$(run validate_retry x.dmg); [ "$rc" = 0 ] && [ "$(count validate)" = 1 ] && ok "a validate that works the first time is called once" || fail "validate first try: rc=$rc calls=$(count validate)"
export STUB_VALIDATE_FAILS=2; rc=$(run validate_retry x.dmg); [ "$rc" = 0 ] && [ "$(count validate)" = 3 ] && ok "two failed validates and a success: three tries, return 0" || fail "validate retry: rc=$rc calls=$(count validate)"
export STUB_VALIDATE_FAILS=99; rc=$(run validate_retry x.dmg); [ "$rc" = 1 ] && [ "$(count validate)" = 3 ] && ok "a validate that never works gives up after three tries and returns 1" || fail "validate gives up: rc=$rc calls=$(count validate)"
export STUB_VALIDATE_FAILS=99 VALIDATE_TRIES=5; rc=$(run validate_retry x.dmg); [ "$rc" = 1 ] && [ "$(count validate)" = 5 ] && ok "VALIDATE_TRIES sets the number of tries" || fail "VALIDATE_TRIES: rc=$rc calls=$(count validate)"
unset VALIDATE_TRIES STUB_VALIDATE_FAILS
# the verify step uses it for the DMG and the app, and a real failure still fails the job (set -e: the call is bare)
vs=$(awk '/- name: Verify signed, notarized release/{f=1} f&&/- name: Cleanup keychain/{exit} f' "$root/.github/workflows/release.yml")
[ "$(grep -c 'validate_retry ' <<<"$vs")" = 2 ] && ok "the verify step validates the DMG and the app with validate_retry" || fail "verify step: $(grep -c 'validate_retry ' <<<"$vs") validate_retry calls (want 2)"
grep -q 'source tests/release/staple_retry.sh' <<<"$vs" && ok "the verify step sources staple_retry.sh" || fail "the verify step does not source staple_retry.sh"
! grep -qE 'xcrun stapler validate' <<<"$vs" && ok "no bare 'xcrun stapler validate' is left in the verify step" || fail "a bare stapler validate is still in the verify step"
! grep -E 'validate_retry ' <<<"$vs" | grep -qE '\|\||if |!' && ok "validate_retry is called bare, so a real failure fails the job" || fail "validate_retry is guarded: a failure would be swallowed"
[ "$fails" = 0 ] && echo "PASS staple_retry" || { echo "$fails FAILED"; exit 1; }
