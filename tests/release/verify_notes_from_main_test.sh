#!/usr/bin/env bash
# verify-release.sh (#16503): a tag whose notes commit landed after it reads the notes from the main commit whose Gated-commit trailer names the tag's commit; only when that commit is on main
# and touches only RELEASE_NOTES.md. The script's own helper, run against a stand-in gh. No network.
set -uo pipefail
export CORAL_TELEMETRY_DISABLED=1 # nothing here runs Coral, but the telemetry census wants it on every script that names the repository
here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../../tools/verify-release.sh"
fail=0
ok() { [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got '$2', want '$3')"; fail=1; }; }
T="$(mktemp -d /tmp/vrnm.XXXX)"; case "$T" in /tmp/vrnm.????) ;; *) echo "bad temp folder"; exit 1 ;; esac
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
sed -n '/^notes_commit_on_main() {/,/^}/p' "$script" > "$T/helper.sh"
[ -s "$T/helper.sh" ] || { echo "FAIL: notes_commit_on_main is not in verify-release.sh"; exit 1; }
TSHA=4df09ccee77a838e10a56a7193cac3f7da003ad2; NSHA=1dbd88b092148ebe99e7efd91f3e65a43e09a195
cat > "$T/bin/gh" <<'G'
#!/usr/bin/env bash
# a stand-in: MSG is the notes commit's message, CMP the compare status, FILES the commit's files (comma list)
a="$*"
case "$a" in
  *"/commits/v9.9.9 "*|*"/commits/v9.9.9") echo "$TSHA" ;;
  *"commits?sha=main"*) jq -n --arg sha "$NSHA" --arg msg "$MSG" '[{sha: $sha, commit: {message: $msg}}]' | jq -r ".[] | select(.commit.message | split(\"\\n\") | any(. == \"Gated-commit: $TSHA\")) | .sha" ;;
  *"/compare/main..."*) echo "$CMP" ;;
  *"/commits/$NSHA"*) echo "$FILES" ;;
esac
G
chmod +x "$T/bin/gh"
. "$T/helper.sh"
REPO=x/y
run() { ( PATH="$T/bin:$PATH" TSHA=$TSHA NSHA=$NSHA MSG="$1" CMP="$2" FILES="$3"; export TSHA NSHA MSG CMP FILES; notes_commit_on_main v9.9.9 ); }
GOOD=$'Release notes for 2.0.68\n\nGated-commit: '"$TSHA"
ok "the notes commit on main that names the tag's commit is found" "$(run "$GOOD" behind RELEASE_NOTES.md)" "$NSHA"
ok "main's own head counts as on main" "$(run "$GOOD" identical RELEASE_NOTES.md)" "$NSHA"
ok "a commit that is not on main is refused" "$(run "$GOOD" diverged RELEASE_NOTES.md)" ""
ok "a commit ahead of main is refused" "$(run "$GOOD" ahead RELEASE_NOTES.md)" ""
ok "a commit that touches another file is refused" "$(run "$GOOD" behind RELEASE_NOTES.md,coral-go/x.go)" ""
ok "a trailer naming another commit is refused" "$(run $'notes\n\nGated-commit: 0000000000000000000000000000000000000000' behind RELEASE_NOTES.md)" ""
ok "no trailer is refused" "$(run 'notes' behind RELEASE_NOTES.md)" ""
ok "a trailer with text after the sha is refused" "$(run "notes"$'\n\n'"Gated-commit: $TSHA and more" behind RELEASE_NOTES.md)" ""
ok "the verifier wires it in and says where the notes came from" "$(grep -c 'the notes come from' "$script")" 1
exit "$fail"
