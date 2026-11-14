#!/usr/bin/env bash
# tools/release-body.py (#16503): the release page's body is the tag's RELEASE_NOTES.md section; a missing section fails; an @mention never reaches the page. No network.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1 # nothing here runs Coral, but the telemetry census wants it on every script that names the repository
root="$(cd "$(dirname "$0")/../.." && pwd)"
S="$root/tools/release-body.py"
fail=0
ok() { [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got '$2', want '$3')"; fail=1; }; }
D="$(mktemp -d /tmp/rbt.XXXX)"; case "$D" in /tmp/rbt.????) ;; *) echo "bad temp folder"; exit 1 ;; esac
trap 'rm -rf "$D"' EXIT
cat > "$D/n.md" <<'N'
# Release Notes

## v2.0.2 — the new one

Intro line.

- **A fix** (#1): an @mention of the asker no longer answers all ("@Dev @Operator should we ship?"), see `@kept` and @org/team.
```
@inside a fence stays
```

## v2.0.1 — the old one

old body
N
python3 -I "$S" 2.0.2 "$D/n.md" "$D/o.md" >/dev/null 2>&1; ok "the section is built" "$?" 0
ok "the first line is the section's, not the heading" "$(head -1 "$D/o.md")" "Intro line."
ok "the older section is not in the body" "$(grep -c 'old body' "$D/o.md")" 0
ok "a bare mention is put in a code span" "$(grep -c '`@Dev` `@Operator`' "$D/o.md")" 1
ok "an org/team mention is put in a code span" "$(grep -c '`@org/team`' "$D/o.md")" 1
ok "an existing code span is kept" "$(grep -c 'see `@kept`' "$D/o.md")" 1
ok "a fenced block is kept as it was" "$(grep -c '^@inside a fence stays$' "$D/o.md")" 1
cat > "$D/chk.py" <<'P'
import re, sys
t = open(sys.argv[1]).read()
t = re.sub(r"```.*?```", "", t, flags=re.S)
t = re.sub(r"`[^`]*`", "", t)
print(len(re.findall(r"(?<![A-Za-z0-9_@/.])@[A-Za-z0-9]", t)))
P
ok "no bare mention is left in the body" "$(python3 -I "$D/chk.py" "$D/o.md")" 0
python3 -I "$S" 2.0.9 "$D/n.md" "$D/o2.md" >/dev/null 2>&1; ok "a tag with no section fails" "$?" 1
ok "and writes no body" "$([ -e "$D/o2.md" ] && echo yes || echo no)" no
printf '## v3.0.0 — empty\n\n## v2.0.1 — x\n' > "$D/e.md"
python3 -I "$S" 3.0.0 "$D/e.md" "$D/o3.md" >/dev/null 2>&1; ok "an empty section fails" "$?" 1
ok "the real notes build for the newest release" "$(python3 -I "$S" "$(grep -m1 -o '^## v[0-9.]*' "$root/RELEASE_NOTES.md" | cut -c5-)" "$root/RELEASE_NOTES.md" "$D/real.md" >/dev/null 2>&1; echo $?)" 0
exit "$fail"
