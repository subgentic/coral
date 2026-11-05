#!/usr/bin/env bash
# gitleaks_ignore_test.sh: the cloud-tests secrets scan accepts the history findings Security triaged (#13461: 310 fingerprints, no real credential) through .gitleaksignore (#13519), and still fails on a NEW finding.
# A gitleaks --baseline-path cannot take that report: the baseline matcher compares whole findings (message, author, columns, match), and the triaged report keeps only RuleID, File, StartLine, Commit, Fingerprint and Description.
# By text: the file holds the triaged fingerprints, one per line, each commit:file:rule:line, never a whole file or directory, the workflow's scan still redacts and still reads .gitleaksignore.
# By running: a scratch repo with a planted fake token: the scan fails; with that token's fingerprint in .gitleaksignore it passes; a second token committed after still fails. Needs go and the gitleaks module; skipped without them.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/gitleaks-ignore-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { echo "ok: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
VER=v8.21.2
ign="$root/.gitleaksignore"; wf="$root/.github/workflows/cloud-tests.yml"

fp='^([0-9a-f]{40}:)?[^:[:space:]]+:[a-z0-9-]+:[0-9]+$'   # commit:file:rule:line, or file:rule:line for a tree scan
n=$(grep -c -E "$fp" "$ign" || true)
[ "$n" -ge 320 ] && ok "$n fingerprints are in .gitleaksignore (the 13 earlier ones and the 310 triaged)" || fail "only $n fingerprint lines in .gitleaksignore (want 320 or more)"
bad=$(grep -v -E "^[[:space:]]*(#|$)|$fp" "$ign" || true)
[ -z "$bad" ] && ok "every line is a comment or one commit:file:rule:line fingerprint" || fail "lines that are not a comment or a fingerprint: $(echo "$bad" | head -2)"
dups=$(grep -E "$fp" "$ign" | sort | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && ok "no fingerprint is listed twice" || fail "$dups fingerprints are listed twice"
grep -q "gitleaks/v8@$VER detect --source . --config .gitleaks.toml --no-banner --redact" "$wf" && ok "the scan job still runs the pinned gitleaks, redacted, with the repo's config" || fail "the scan job changed: it must still run gitleaks $VER with --redact and .gitleaks.toml"
! grep -q -- "--baseline-path" "$wf" && ok "no baseline flag (a baseline would need the full findings)" || fail "the scan job passes --baseline-path"
grep -q "^# triaged" "$ign" && ok ".gitleaksignore says where the triaged fingerprints come from" || fail ".gitleaksignore does not say the triaged fingerprints' origin"

if ! command -v go >/dev/null 2>&1; then echo "skip: go not found, the running part is not run"; [ "$fails" = 0 ] && echo "PASS gitleaks_ignore (text only)" || { echo "$fails FAILED"; exit 1; }; exit 0; fi
gl() { go run "github.com/zricethezav/gitleaks/v8@$VER" "$@"; }
repo="$tmp/repo"; mkdir -p "$repo"; cd "$repo"
git init -q . && git config user.email t@example.invalid && git config user.name t
printf '# a scratch repo\n' >README.md; git add README.md; git commit -q -m one
printf 'token = "ghp_%s"\n' "R7kQ2mXv9LpT4wZb8NcD3fHj6YsE1aUg0Ixo" >one.txt; git add one.txt; git commit -q -m planted
scan() { gl detect --source . --no-banner --redact --report-format json --report-path "$tmp/report.json" >"$tmp/out" 2>&1 && echo 0 || echo $?; }
[ "$(scan)" = 1 ] && ok "a planted token fails the scan" || fail "the planted token did not fail the scan"
python3 -c "import json,sys; [print(f['Fingerprint']) for f in json.load(open('$tmp/report.json'))]" >"$repo/.gitleaksignore"
git add .gitleaksignore; git commit -q -m "triage the first token"
[ "$(scan)" = 0 ] && ok "the token passes once its fingerprint is in .gitleaksignore" || fail "the ignored token still fails"
printf 'second = "ghp_%s"\n' "Z4cV8bN2mQ6wE0rT7yU3iO9pA5sD1fGhJ2kL" >two.txt; git add two.txt; git commit -q -m second
r=$(scan); [ "$r" = 1 ] && ok "a NEW token still fails with the ignore in place" || fail "a new token was accepted (scan exit $r; findings: $(python3 -c "import json; print(len(json.load(open('$tmp/report.json'))))" 2>/dev/null))"
[ "$fails" = 0 ] && echo "PASS gitleaks_ignore" || { echo "$fails FAILED"; exit 1; }
