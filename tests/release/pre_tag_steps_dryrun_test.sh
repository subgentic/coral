#!/usr/bin/env bash
# tools/devops/pre-tag-steps.sh names the release dry run for the commit (#19780): with a stand-in gh, an empty run list prints NO-DRYRUN (not
# 'null null null', QA round 1), a finished run prints DRYRUN with its result, a queued or running one prints NOT-FINISHED.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/pre-tag-dryrun-test.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
# the stand-in gh answers `gh run list ... --jq EXPR` by running real jq on $GH_JSON with EXPR, as gh does
cat > "$T/bin/gh" <<'G'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do [ "$1" = --jq ] && { expr=$2; break; }; shift; done
printf '%s' "$GH_JSON" | jq -r "$expr"
G
chmod +x "$T/bin/gh"
command -v jq >/dev/null || { echo "SKIP: jq not installed"; exit 0; }
fail=0
run() { GH_JSON="$1" PATH="$T/bin:$PATH" bash "$root/tools/devops/pre-tag-steps.sh" HEAD HEAD 2>&1 | tail -1; }
check() { case "$2" in *"$3"*) echo "ok: $1" ;; *) echo "FAIL: $1: got '$2', want '$3'"; fail=1 ;; esac; }
check "no run -> NO-DRYRUN" "$(run '[]')" "NO-DRYRUN"
out=$(run '[]'); case "$out" in *null*) echo "FAIL: empty list printed null"; fail=1 ;; esac
check "finished run -> DRYRUN with result" "$(run '[{"databaseId":7,"status":"completed","conclusion":"success"}]')" "DRYRUN    run 7 completed success"
check "running run -> NOT-FINISHED" "$(run '[{"databaseId":8,"status":"in_progress","conclusion":null}]')" "NOT-FINISHED"
check "queued run -> NOT-FINISHED" "$(run '[{"databaseId":9,"status":"queued","conclusion":null}]')" "NOT-FINISHED"
[ "$fail" = 0 ] && echo "pre_tag_steps_dryrun_test: ok"
exit "$fail"
