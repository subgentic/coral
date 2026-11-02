package ptymanager

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// An agent may be put to sleep only from an empty input box: a draft, an unreadable or blank screen, a terminal with no screen to read and an open dialog each stop it (#12111).
func TestScreenStopsSleep(t *testing.T) {
	ctx := context.Background()
	f := &fakeAgent{}
	f.show(claudeMidTurn) // the box is empty (a turn is running, which the idle check decides, not the screen)
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "an empty box")

	f.show("──────────────────────────────────────────────────────────────────────\n❯ half a sentence the person was typing\n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on\n")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a draft")

	f.show(trustDialog)
	assert.Equal(t, SleepStopDialog, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a dialog")

	f.show(claudeIdleWithShell)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a background shell the footer names")
	f.show(claudeMonitorWithText)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a monitor the footer names")

	f.show("")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a blank screen counts as a draft")

	f.show(claudeMidTurn)
	f.readErr = errors.New("no pane")
	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a screen that cannot be read counts as a draft")

	assert.Equal(t, SleepStopDraft, ScreenStopsSleep(ctx, struct{}{}, "claude-x", "claude", "x", false), "a terminal with no screen to read")
}

// An agent parked in its own `coral-board wait` shows one background shell in its footer: that one is not a reason to stay awake, anything more is (#12335).
func TestScreenStopsSleepOwnWaitIsTheOneBackgroundShell(t *testing.T) {
	ctx := context.Background()
	f := &fakeAgent{}
	f.show(claudeIdleWithShell)
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", true), "one shell and a registered wait: it is the wait")
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "one shell and no wait: a real background run")
	f.show(strings.ReplaceAll(claudeIdleWithShell, "1 shell", "2 shells"))
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", true), "two shells: one of them is not the wait")
	f.show(strings.ReplaceAll(strings.ReplaceAll(claudeIdleWithShell, "1 shell still running", "something still running"), "· 1 shell ·", "·"))
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", true), "'still running' with no count is not known to be the wait")
}
