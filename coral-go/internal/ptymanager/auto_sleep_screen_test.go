package ptymanager

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
)

// An agent may be put to sleep only from an empty input box: a draft, an unreadable or blank screen, a terminal with no screen to read and an open dialog each stop it (#12111).
func TestScreenStopsSleep(t *testing.T) {
	ctx := context.Background()
	f := &fakeAgent{}
	f.show(claudeMidTurn) // the box is empty (a turn is running, which the idle check decides, not the screen)
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "an empty box")

	f.show("──────────────────────────────────────────────────────────────────────\n❯ half a sentence the person was typing\n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on\n")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a draft")

	f.show(trustDialog)
	assert.Equal(t, SleepStopDialog, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a dialog")

	f.show(claudeIdleWithShell)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a background shell the footer names")
	f.show(claudeMonitorWithText)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a monitor the footer names")

	f.show("")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a blank screen counts as a draft")

	f.show(claudeMidTurn)
	f.readErr = errors.New("no pane")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x"), "a screen that cannot be read counts as a draft")

	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, struct{}{}, "claude-x", "claude", "x"), "a terminal with no screen to read")
}
