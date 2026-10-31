package main

import (
	"strings"
	"testing"
)

// A post must notify someone (#11441): the docs say so, and say nothing of any way around it (the opt-out is the operator's own, for scripts).
func TestPostMustNotifySomeoneIsInTheDocs(t *testing.T) {
	srv := realDocsServer(t)
	code, out, errOut := runAgentWithToken(t, srv.URL, "docs", "board")
	if code != 0 {
		t.Fatalf("docs board: exit %d: %s", code, errOut)
	}
	for _, w := range []string{"A post must notify someone", "this post notifies nobody: add @Name, --to, or --task", "`--task N`, which tells the task's assignee and its creator"} {
		if !strings.Contains(out, w) {
			t.Errorf("docs board lacks %q", w)
		}
	}
	code, all, errOut := runAgentWithToken(t, srv.URL, "docs", "all")
	if code != 0 {
		t.Fatalf("docs all: exit %d: %s", code, errOut)
	}
	for _, banned := range []string{"--broadcast", "--fyi"} {
		if strings.Contains(all, banned) {
			t.Errorf("an agent doc names the operator's opt-out %q", banned)
		}
	}
}
