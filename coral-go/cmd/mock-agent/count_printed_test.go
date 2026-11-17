package main

import "testing"

// #14416: the heartbeat's log counts the messages its read took, one or many, and none for "No new messages." (the old count of "\n[" said 0 for exactly one).
func TestCountPrintedMessages(t *testing.T) {
	one := "[2026-11-08T00:26] Operator: @Orchestrator From the Operator: please read a comment on an artifact\n"
	two := one + "[2026-11-08T00:27] Coral: [Coral] a second line with a bracket\n  (a reply on task #5: answer it)\n"
	for _, c := range []struct {
		out  string
		want int
	}{
		{"No new messages.\n", 0},
		{"", 0},
		{one, 1},
		{two, 2},
		{one + "[Coral] a line inside the first message\n", 1},
	} {
		if got := countPrintedMessages(c.out); got != c.want {
			t.Errorf("countPrintedMessages(%q) = %d, want %d", c.out, got, c.want)
		}
	}
}
