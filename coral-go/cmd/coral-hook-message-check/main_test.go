package main

import (
	"github.com/subgentic/coral/internal/board"
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
	if !strings.Contains(got, "You have unread messages on the message board. Run 'coral-board read' to see them.") {
		t.Errorf("unread messages on a board that is not paused are said as before: %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(1)}); !strings.Contains(got, "You have unread messages on") {
		t.Errorf("one message is singular: %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(0)}); got != "" {
		t.Errorf("none: nothing is said, got %q", got)
	}
	if got := unreadNotice(map[string]any{"unread": float64(2), "paused": false}); got == "" {
		t.Errorf("paused: false is not paused")
	}
}

// The hook says what the notifier's nudge says, with no number in it (#18753): the hook keeps its own copy so the binary does not import the board.
func TestTheHooksNoticeIsTheNudgeText(t *testing.T) {
	got := unreadNotice(map[string]any{"unread": float64(7)})
	if !strings.Contains(got, board.NudgeText()) {
		t.Fatalf("hook notice %q does not carry %q", got, board.NudgeText())
	}
	if strings.ContainsAny(board.NudgeText(), "0123456789") {
		t.Fatalf("the nudge states a number: %q", board.NudgeText())
	}
}
