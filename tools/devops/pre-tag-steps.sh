#!/usr/bin/env bash
# pre-tag-steps.sh LAST_TAG [HEAD]: the release-only steps (tests/release/pre_tag_steps.txt) that the dry run does NOT run, each with whether the
# code it runs changed since LAST_TAG. The pre-tag post (#13015, Part C) names every one: read the CHANGED ones against the diff and say so.
#   tools/devops/pre-tag-steps.sh v2.0.65 f9d68cd63
set -euo pipefail
last=${1:?usage: pre-tag-steps.sh LAST_TAG [HEAD]}
head=${2:-HEAD}
root=$(cd "$(dirname "$0")/../.." && pwd)
list="$root/tests/release/pre_tag_steps.txt"
git -C "$root" rev-parse --verify -q "$last^{commit}" >/dev/null || { echo "pre-tag-steps: no such commit: $last" >&2; exit 2; }
git -C "$root" rev-parse --verify -q "$head^{commit}" >/dev/null || { echo "pre-tag-steps: no such commit: $head" >&2; exit 2; }
changed=$(git -C "$root" diff --name-only "$last" "$head")
echo "release-only steps (the dry run does not run these; $last..$head):"
n=0
while IFS='|' read -r item stage why; do
  item=$(echo "$item" | sed 's/^ *//;s/ *$//'); stage=$(echo "$stage" | sed 's/^ *//;s/ *$//'); why=$(echo "$why" | sed 's/^ *//')
  case "$item" in ''|'#'*) continue ;; esac
  [ "$stage" = release-only ] || continue
  n=$((n + 1))
  case "$item" in
    "go test "*) pkg=$(echo "$item" | awk '{print $3}'); pkg=${pkg#./}; path="coral-go/$pkg/" ;;
    *) path="$item" ;;
  esac
  if echo "$changed" | grep -q -- "^$path"; then st=CHANGED; else st=unchanged; fi
  printf '  %-9s %s  (%s)\n' "$st" "$item" "$why"
done < "$list"
echo "$n release-only steps; name each in the pre-tag post, and read the CHANGED ones"
# The dry run is the step that runs everything else marked dryrun in the list (tests/release/ldflags_build_test.sh among them): v2.1.1 was tagged
# without one and its release failed on that check (#19780). Name it in the pre-tag post with its result for this commit.
sha=$(git -C "$root" rev-parse "$head^{commit}")
echo "release dry run (runs every 'dryrun' step in pre_tag_steps.txt, incl. tests/release/ldflags_build_test.sh), on $sha:"
if command -v gh >/dev/null 2>&1; then
  dr=$(gh run list --workflow release-dryrun.yml --commit "$sha" --limit 1 --json databaseId,status,conclusion --jq 'if length == 0 then "" else .[0] | "\(.databaseId) \(.status) \(.conclusion)" end' 2>/dev/null || true)
else
  dr=""
fi
if [ -n "$dr" ] && [ "$dr" != "null" ]; then
  echo "  DRYRUN    run $dr  (a provenance-only FAIL while the gates still run is expected; any other failed step is not)"
else
  echo "  NO-DRYRUN none for this commit: gh workflow run release-dryrun.yml --ref main   (the candidate is the commit main is on)"
fi
