package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #16875 (found in the real Antigravity run of #15552): agy 1.5.8 draws the current mode as a hint in its empty input box ("> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)"),
// and the draft check took it for a person's text, so nothing automated was ever typed into an agy agent: no board nudge, no /send, no /compact. The hints are matched by their shape, whole;
// anything a person typed, even one that starts like a hint, is still a draft.
var agyModeHints = []string{
	"Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
	"Accept-edits mode: file edits auto-approved (shift+tab to cycle)",
	"Plan mode: research & plan only (shift+tab to cycle)",
	"Best-of-N mode: fork into parallel arms and pick a winner (shift+tab to cycle)",
	"--dangerously-skip-permissions: auto-approving all tool permissions",
}

func agyIdleScreen(line string) string {
	return "\n  I have introduced myself on the message board as Reader and am standing by for instructions.\n\n────────────────────────────────────────────────────────────────────────────────────────────────────\n" + line + "\n────────────────────────────────────────────────────────────────────────────────────────────────────\n? for shortcuts                                       auto · Gemini 4 Argon · medium\n"
}

func TestAgyModeHintIsAnEmptyBox(t *testing.T) {
	for _, hint := range agyModeHints {
		screen := agyIdleScreen("> " + hint)
		box, ok := inputBoxText(screen)
		assert.True(t, ok, hint)
		assert.True(t, emptyBox(box, false), "the mode hint is not a draft: "+hint)
		assert.True(t, boxPlaceholder("  "+hint+"  "), "padded: "+hint)
	}
}

func TestAgyDraftIsStillADraft(t *testing.T) {
	for _, draft := range []string{
		"fix the failing test in cart.go",
		"Auto mode",
		"Auto mode: please explain this (shift+tab to cycle) to me, then stop",
		"Plan mode: research & plan only (shift+tab to cycle) and then delete the folder",
		"x Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
		"--dangerously-skip-permissions: auto-approving all tool permissions, then rm -rf",
	} {
		box, ok := inputBoxText(agyIdleScreen("> " + draft))
		assert.True(t, ok, draft)
		assert.False(t, emptyBox(box, false), "a person's text: "+draft)
	}
}
