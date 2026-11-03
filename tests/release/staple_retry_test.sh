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
# xcrun stapler staple|validate PATH: STUB_STAPLE_FAILS counts how many staple calls fail before one works; STUB_VALIDATE_FAIL=1 makes validate fail.
echo "$2 $3" >>"$STUB_LOG"
if [ "$2" = staple ]; then
  n=$(grep -c '^staple ' "$STUB_LOG"); [ "$n" -gt "${STUB_STAPLE_FAILS:-0}" ] || exit 1
fi
if [ "$2" = validate ] && [ "${STUB_VALIDATE_FAIL:-}" = 1 ]; then exit 1; fi
exit 0
SH
chmod 755 "$tmp/bin/xcrun"
export PATH="$tmp/bin:$PATH" STAPLE_WAIT=0 STAPLE_TRIES=5
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
# unstapled says so and sets UNSTAPLED=1 for the later steps
export GITHUB_ENV="$tmp/env"; : >"$GITHUB_ENV"
out="$(unstapled "Coral.app")"; grep -q "^::warning::Coral.app is notarized" <<<"$out" && grep -qx "UNSTAPLED=1" "$GITHUB_ENV" && ok "unstapled warns and sets UNSTAPLED=1" || fail "unstapled: $out / $(cat "$GITHUB_ENV")"

# the workflow's guards, by text: an Accepted check comes before each unstapled path, and the verify step skips spctl and validate when unstapled
wf="$root/.github/workflows/release.yml"
a=$(grep -n 'status: Accepted' "$wf" | head -1 | cut -d: -f1 || true); s1=$(grep -n 'staple_retry dist/Coral.app' "$wf" | head -1 | cut -d: -f1 || true)
[ -n "$a" ] && [ -n "$s1" ] && [ "$a" -lt "$s1" ] && ok "the app's Accepted check comes before its staple" || fail "app: accepted line $a, staple line $s1"
b=$(grep -n '"$STATUS" = "Accepted"' "$wf" | head -1 | cut -d: -f1 || true); s2=$(grep -n 'staple_retry "dist/$DMG_NAME"' "$wf" | head -1 | cut -d: -f1 || true)
[ -n "$b" ] && [ -n "$s2" ] && [ "$b" -lt "$s2" ] && ok "the DMG's Accepted check comes before its staple" || fail "dmg: accepted line $b, staple line $s2"
[ "$(grep -c 'UNSTAPLED:-}" != 1' "$wf" || true)" = 2 ] && ok "the verify step guards spctl and stapler validate for the DMG and for the app" || fail "verify guards: $(grep -c 'UNSTAPLED:-}" != 1' "$wf")"
if grep -nE '^[[:space:]]*xcrun stapler (staple|validate) ' "$wf" | grep -v "staple_retry" | grep -q "stapler staple"; then fail "a bare 'stapler staple' is still in release.yml"; else ok "no bare stapler staple is left in release.yml"; fi
[ "$fails" = 0 ] && echo "PASS staple_retry" || { echo "$fails FAILED"; exit 1; }
