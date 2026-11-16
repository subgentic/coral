package frontend

import (
	"regexp"
	"strings"
	"testing"
)

// The shell holds each id once (#18818). The Queue pane's header (#18719) drew a Display options panel that was the history filters again, so hf-advanced and hf-fts-mode-row were on the page
// twice: getElementById found the first, in a pane that was hidden, and the Advanced filters never opened on a phone or the Hub.
func TestTheShellRepeatsNoId(t *testing.T) {
	tmpl, err := ParseIndex()
	if err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	if err := tmpl.Execute(&b, PageData{StaticBase: "/static/b/x/", CoralRoot: "/r"}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, m := range regexp.MustCompile(`\sid="([^"{}]+)"`).FindAllStringSubmatch(b.String(), -1) {
		seen[m[1]]++
	}
	for id, n := range seen {
		if n > 1 {
			t.Errorf("id %q is on the page %d times", id, n)
		}
	}
	if seen["hf-advanced"] != 1 || seen["hf-fts-mode-row"] != 1 {
		t.Errorf("the history filters' ids: hf-advanced %d, hf-fts-mode-row %d, want 1 each", seen["hf-advanced"], seen["hf-fts-mode-row"])
	}
}
