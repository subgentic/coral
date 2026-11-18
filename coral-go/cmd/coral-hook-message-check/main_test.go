package main

import (
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/hooks"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// #19622: the line was printed after every tool call while anything was unread. It is said once per batch: at once when messages first wait, then not again until they are read (and more come) or five minutes pass.
func TestTheUnreadLineIsSaidOncePerBatch(t *testing.T) {
	path := t.TempDir() + "/said"
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	if saidRecently(path, now) {
		t.Fatal("the first call of a batch says the line")
	}
	for i := 1; i <= 5; i++ {
		if !saidRecently(path, now.Add(time.Duration(i)*20*time.Second)) {
			t.Fatalf("call %d inside the window is quiet", i)
		}
	}
	if saidRecently(path, now.Add(5*time.Minute+time.Second)) {
		t.Fatal("after five minutes it is said again")
	}
	forgetSaid(path) // everything was read
	if saidRecently(path, now.Add(5*time.Minute+2*time.Second)) {
		t.Fatal("a new batch after a read is said at once")
	}
}

// #19622 (the join census): the said-state file is in the data folder whatever the session name says.
func TestTheSaidStateFileStaysInTheDataFolder(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	for _, name := range []string{"../../etc/x", "a/b", `a\b`, "..", "../", "/abs/path", ""} {
		got := saidStatePath(name)
		if filepath.Dir(got) != filepath.Clean(hooks.CoralDir()) {
			t.Errorf("name %q: %q is not directly in %q", name, got, hooks.CoralDir())
		}
		if strings.Contains(filepath.Base(got), "/") || strings.Contains(filepath.Base(got), `\`) {
			t.Errorf("name %q: base %q holds a separator", name, filepath.Base(got))
		}
	}
}
