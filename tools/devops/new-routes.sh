#!/usr/bin/env bash
# tools/devops/new-routes.sh PREV NEW (#16727): the list coral-hub gets with every tag: the routes and the embedded html files that are NEW since the previous tag.
# Four Hub guards fail on each new route or embedded html (v2.0.68 cost two red runs: the custom-modes routes and password-reset.html), so the Hub team hears of them with the tag.
# For each tag the route table (coral-go/pkg/tunnel routeTable) is dumped by a throwaway test in a throwaway worktree (nothing is committed or left behind), as
# "METHOD<TAB>PATTERN<TAB>view|interact|launch|never<TAB>owner-refused true|false<TAB>service true|false"; the html files are git's list of *.html under coral-go/pkg/frontend.
# Output (stdout, Markdown): NEW routes (method, path, tier, owner-refused), routes whose tier or owner rule CHANGED, and NEW embedded html files; "none" for an empty group.
#   new-routes.sh vPREV vNEW          the list for a tag pair
#   new-routes.sh --diff PREV.tsv NEW.tsv   the same comparison of two dumps (the test uses it; no git, no Go)
set -uo pipefail
diff_dumps() { # PREV.tsv NEW.tsv: new rows, changed rows, by "METHOD PATTERN"
  awk -F'\t' 'NR==FNR { k=$1 " " $2; prev[k]=$3 "\t" $4 "\t" $5; next }
    { k=$1 " " $2; cur=$3 "\t" $4 "\t" $5
      if (!(k in prev)) printf "NEW\t%s\t%s\t%s\t%s\n", $1, $2, $3, ($4=="true" ? "owner-refused" : "not owner-refused") ;
      else if (prev[k] != cur) { split(prev[k], p, "\t"); printf "CHANGED\t%s\t%s\t%s -> %s\t%s\n", $1, $2, p[1], $3, ($4=="true" ? "owner-refused" : "not owner-refused") } }' "$1" "$2" | sort -u
}
render() { # RAW_DIFF PREV_HTML NEW_HTML: the Markdown
  local raw="$1" ph="$2" nh="$3" n c h
  n="$(awk -F'\t' '$1=="NEW" { printf "- %s %s: %s, %s\n", $2, $3, $4, $5 }' <<<"$raw")"
  c="$(awk -F'\t' '$1=="CHANGED" { printf "- %s %s: %s, %s\n", $2, $3, $4, $5 }' <<<"$raw")"
  h="$(comm -13 <(sort <<<"$ph") <(sort <<<"$nh") | sed 's/^/- /')"
  printf 'New routes:\n%s\n\nRoutes whose tier or owner rule changed:\n%s\n\nNew embedded html files:\n%s\n' "${n:-none}" "${c:-none}" "${h:-none}"
}
if [ "${1:-}" = "--diff" ]; then
  [ -f "${2:-}" ] && [ -f "${3:-}" ] || { echo "usage: new-routes.sh --diff PREV.tsv NEW.tsv" >&2; exit 2; }
  render "$(diff_dumps "$2" "$3")" "" ""; exit 0
fi
PREV="${1:?usage: new-routes.sh vPREV vNEW}"; NEW="${2:?usage: new-routes.sh vPREV vNEW}"
R="$(git rev-parse --show-toplevel)" || exit 1
for t in "$PREV" "$NEW"; do git -C "$R" rev-parse -q --verify "$t^{commit}" >/dev/null || { echo "new-routes: '$t' is not a tag or commit here" >&2; exit 1; }; done
T="$(mktemp -d /tmp/newroutes.XXXX)"; case "$T" in /tmp/newroutes.????) ;; *) echo "bad temp folder" >&2; exit 1 ;; esac
trap 'for w in "$T"/prev "$T"/new; do git -C "$R" worktree remove --force "$w" 2>/dev/null; done; rm -rf "$T"' EXIT
dump() { # TAG LABEL: $T/LABEL.tsv
  git -C "$R" worktree add -q --detach "$T/$2" "$1" || return 1
  cat > "$T/$2/coral-go/pkg/tunnel/zz_dump_routes_test.go" <<'GO'
package tunnel

import (
	"fmt"
	"os"
	"testing"
)

func TestDumpRouteTableForRelease(t *testing.T) {
	p := os.Getenv("CORAL_DUMP_ROUTES")
	if p == "" {
		t.Skip("only for tools/devops/new-routes.sh")
	}
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, r := range routeTable {
		fmt.Fprintf(f, "%s\t%s\t%s\t%v\t%v\n", r.method, r.pattern, r.tier, r.owner.Refuses(), r.service)
	}
}
GO
  ( cd "$T/$2/coral-go" && CORAL_DUMP_ROUTES="$T/$2.tsv" go test -count=1 -run '^TestDumpRouteTableForRelease$' ./pkg/tunnel/ >"$T/$2.log" 2>&1 ) || { echo "new-routes: the route dump of $1 failed:" >&2; tail -5 "$T/$2.log" >&2; return 1; }
  [ -s "$T/$2.tsv" ] || { echo "new-routes: the route dump of $1 is empty" >&2; return 1; }
}
dump "$PREV" prev || exit 1; dump "$NEW" new || exit 1
html() { git -C "$R" ls-tree -r --name-only "$1" -- coral-go/pkg/frontend | grep '\.html$' | sed 's#^coral-go/pkg/frontend/##'; }
echo "Routes and embedded html files new in $NEW since $PREV (route table: coral-go/pkg/tunnel/routes.go):"; echo
render "$(diff_dumps "$T/prev.tsv" "$T/new.tsv")" "$(html "$PREV")" "$(html "$NEW")"
