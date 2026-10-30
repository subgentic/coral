package main

import (
	"strings"
	"testing"
)

// #11198 (QA's MUST): a paused board's check answers the real count with paused: true, and read delivers none of it. The hook that runs after every tool call says nothing then; before, it printed
// "You have 3 unread messages ... Run coral-board read" after every call on a paused board, a dead end repeated.
func TestThePostToolHookSaysNothingForAPausedBoard(t *testing.T) {
	if got := unreadNotice(map[string]any{"unread": float64(3), "paused": true}); got != "" {
		t.Errorf("a paused board: nothing is said, got %q", got)
	}
	got := unreadNotice(map[string]any{"unread": float64(3)})
	if !strings.Contains(got, "You have 3 unread messages on the message board. Run 'coral-board read' to see them.") {
		t.Errorf("unread messages on a board that is not paused are said as before: %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(1)}); !strings.Contains(got, "1 unread message on") || strings.Contains(got, "messages on") {
		t.Errorf("one message is singular: %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(0)}); got != "" {
		t.Errorf("none: nothing is said, got %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(2), "paused": false}); got == "" {
		t.Errorf("paused: false is not paused")
	}
}
