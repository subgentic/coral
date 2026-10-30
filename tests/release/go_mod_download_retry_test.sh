#!/usr/bin/env bash
# The module-download step of release.yml's resolve job and of release-dryrun.yml (#11047): run its script against stand-in go, sleep and timeout programs.
# A dropped download is retried up to four times; a checksum mismatch is never retried into green (Security on #11300); both workflows carry the same script.
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0; ok() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; fail=1; }

extract() { # the run: block of the step, dedented
  python3 - "$1" <<'PY'
import sys,re
lines=open(sys.argv[1]).read().split('\n')
i=next(k for k,l in enumerate(lines) if 'name: Download the Go modules, retrying a dropped download' in l)
j=next(k for k in range(i,len(lines)) if lines[k].strip()=='run: |')
ind=len(lines[j+1])-len(lines[j+1].lstrip())
out=[]
for l in lines[j+1:]:
    if l.strip() and (len(l)-len(l.lstrip()))<ind: break
    out.append(l[ind:] if l.strip() else '')
print('\n'.join(out))
PY
}
a="$(extract .github/workflows/release.yml)"; b="$(extract .github/workflows/release-dryrun.yml)"
[ -n "$a" ] && [ "$a" = "$b" ] && ok "release.yml and release-dryrun.yml carry the same download script" || bad "the two workflows' download scripts differ or were not found"

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf '%s\n' "$a" > "$T/step.sh"
printf '#!/bin/bash\nexit 0\n' > "$T/sleep"; printf '#!/bin/bash\nshift\nexec "$@"\n' > "$T/timeout"
cat > "$T/go" <<'SH'
#!/bin/bash
n=$(cat "$COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNT"
if [ "$n" -le "${FAIL_FIRST:-0}" ]; then echo "${MSG:-stream error: stream ID 5; INTERNAL_ERROR}" >&2; exit 1; fi
exit 0
SH
chmod +x "$T/sleep" "$T/timeout" "$T/go"
run() { echo 0 > "$T/c"; COUNT="$T/c" FAIL_FIRST="$1" MSG="${2:-}" PATH="$T:$PATH" bash -e "$T/step.sh" > "$T/out" 2>&1; echo "$? $(cat "$T/c")"; }

[ "$(run 0)" = "0 1" ] && ok "a download that works is tried once" || bad "a working download: $(run 0)"
[ "$(run 2)" = "0 3" ] && ok "two dropped streams are retried into success" || bad "two dropped streams: $(run 2)"
[ "$(run 3)" = "0 4" ] && ok "three dropped streams are retried into success on the fourth try" || bad "three dropped streams: $(run 3)"
[ "$(run 9)" = "1 4" ] && ok "four failures in a row fail the step after four tries" || bad "four failures: $(run 9)"
r="$(run 1 'verifying example.com/m@v1.0.0: checksum mismatch')"; [ "$r" = "1 1" ] && ok "a checksum mismatch fails at once, never retried into green" || bad "a checksum mismatch: $r"
r="$(run 1 'SECURITY ERROR')"; [ "$r" = "1 1" ] && ok "a SECURITY ERROR fails at once" || bad "a SECURITY ERROR: $r"
grep -q 'timeout 300 go mod download' "$T/step.sh" && ok "each try is cut at 300 seconds" || bad "no timeout 300 on the download"
exit $fail
