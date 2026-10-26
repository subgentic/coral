package ptymanager

import (
	"sync"
	"testing"
)

// #4057: ForgetSession (a session's kill, restart, resume or new launch) calls every registered
// session-end hook with the session's name, its tmux target suffix removed.
func TestForgetSessionCallsTheSessionEndHooks(t *testing.T) {
	var mu sync.Mutex
	got := map[string]int{}
	OnSessionEnd(func(name string) {
		mu.Lock()
		got[name]++
		mu.Unlock()
	})
	ForgetSession("claude-4057-hook")
	ForgetSession("claude-4057-hook:0.0")
	mu.Lock()
	defer mu.Unlock()
	if got["claude-4057-hook"] != 2 {
		t.Fatalf("hook calls: %v", got)
	}
}
