//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// #14476 (QA's SHOULD on #14416): the heartbeat's own call site. readMessages runs `coral-board read` and logs how many messages it printed; a single printed message must log 1 (counting "\n[" in the output
// said 0 for exactly one, which hid a message the heartbeat had taken). The coral-board here is a script that prints what a real read prints, so the count is taken from the real call, not from the helper alone.
func TestTheHeartbeatsReadLogsHowManyMessagesItPrinted(t *testing.T) {
	for _, c := range []struct {
		name, printed string
		want          int
	}{
		{"nothing new", "No new messages.\n", 0},
		{"one message", "[2026-11-08T00:26] Operator: @Orchestrator please read a comment on an artifact\n", 1},
		{"two messages", "[2026-11-08T00:26] Operator: first\n[2026-11-08T00:27] Coral: second\n  (a reply on task #5: answer it)\n", 2},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			out := filepath.Join(dir, "printed.txt")
			if err := os.WriteFile(out, []byte(c.printed), 0o600); err != nil {
				t.Fatal(err)
			}
			script := filepath.Join(dir, "coral-board")
			if err := os.WriteFile(script, []byte("#!/bin/sh\ncat \""+out+"\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("MOCK_AGENT_CORAL_BOARD", script)
			if got := readMessages("http://127.0.0.1:1", "board"); got != c.want {
				t.Errorf("the heartbeat logged %d messages for %q, want %d", got, c.printed, c.want)
			}
		})
	}
}
