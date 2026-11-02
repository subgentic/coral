package ptymanager

import (
	"context"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

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

// Only the footer counts (#12335, Beta Tester's parked workers: no marker on the screen, background_running anyway): an earlier turn's line far up the pane and the agent's own words are not a shell running now.
func TestScreenStopsSleepOnlyReadsTheFooter(t *testing.T) {
	ctx := context.Background()
	f := &fakeAgent{}
	box := "──────────────────────────────────────────────────────────────────────\n❯ \n──────────────────────────────────────────────────────────────────────\n  ⏵⏵ manual mode on · ? for shortcuts\n"
	old := "✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n" + strings.Repeat("text of a later turn\n", 12)
	f.show(old + "✱ Crunched for 24s · done 5:56 AM\n\n" + box)
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "a marker twelve lines up, in an earlier turn, is not a shell running now")
	f.show("I set a wait; the old shell is still running somewhere, 2 shells ago.\n✱ Crunched for 24s · done 5:56 AM\n\n" + box)
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "the agent's own words have no middle dot: not a footer")
	f.show("✱ Crunched for 24s · done 5:56 AM · 1 shell still running\n\n" + box)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "the footer says so")
	assert.Equal(t, "· done 5:56 AM · 1 shell", BackgroundMarker("✱ Crunched for 24s · done 5:56 AM · 1 shell still running\n\n"+box))
}

// The footer is anchored on the input box, not on a count of lines (Security, #12335): notices under the box that push the status line past any fixed window do not hide it, and history above never counts.
func TestScreenStopsSleepFooterIsAnchoredOnTheBox(t *testing.T) {
	ctx := context.Background()
	f := &fakeAgent{}
	rule := "──────────────────────────────────────────────────────────────────────\n"
	notices := strings.Repeat("  ✔ a notice under the box\n", 14)
	f.show("✻ Cogitated for 4s · done 5:38 PM\n\n" + rule + "❯ \n" + rule + "  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage\n" + notices)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "the status line is the first line under the box: fourteen notices after it do not hide it")
	f.show("✻ Cogitated for 4s · done 5:38 PM · 1 shell still running\n\n" + rule + "❯ \n" + rule + "  ⏵⏵ bypass permissions on\n" + notices)
	assert.Equal(t, SleepStopBackground, ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "the line above the box counts however long the footer is")
	f.show("✻ Cogitated for 4s · 1 shell still running\n" + strings.Repeat("text\n", 3) + "✻ Cogitated for 5s · done 5:40 PM\n\n" + rule + "❯ \n" + rule + "  ⏵⏵ bypass permissions on\n")
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "history above the line over the box never counts")
	f.show("✱ Crunched for 24s · done 5:56 AM\n\n" + rule + "❯ \n──[]── manual mode on · ? for shortcuts ──\n")
	assert.Equal(t, "", ScreenStopsSleep(ctx, f, "claude-x", "claude", "x", false), "Beta Tester's parked worker: nothing running")
	assert.Equal(t, "· 1 shell", BackgroundMarker("✻ x · 1 shell still running\n"+rule+"❯ \n"+rule), "the marker is the footer's own words")
	long := BackgroundMarker("x\n" + rule + "❯ \n" + rule + "· " + strings.Repeat("é", 70) + " still running")
	assert.True(t, utf8.ValidString(long) && len([]rune(long)) <= 60, "a long marker is cut on a character boundary: %q", long)
}
