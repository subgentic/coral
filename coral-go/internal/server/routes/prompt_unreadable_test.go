package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/permreview"
)

// #15501 (the Operator, on #15492), kept beside #15140: a request Coral did not read in full is Unreadable, and a card draws no answer for it, not even No. A request read whole that holds a hidden
// character is only OnlyReject: it keeps its No, and the row says when Claude Code blocks it itself (#15140).
func TestARequestCoralDidNotReadInFullIsUnreadableAndOneReadWholeThatHidesIsOnlyRejectOnly(t *testing.T) {
	// the top of the request is not on the screen (the Operator's phone screenshot)
	s, ok := parsePromptScreen(rmScreenWithoutTop("0:42"))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "the server still refuses a Yes")
	assert.True(t, s.Unreadable, "its opening rule is not on the screen: Coral did not read it in full")
	assert.Contains(t, s.Note, "answer it in the agent's terminal")
	assert.NotEmpty(t, s.AutoBlockAt, "the auto-block time stays on the screen read (#15140)")

	// longer than a card shows: not read in full
	long := "  echo " + strings.Repeat("a", permreview.MaxBytes+10) + "\n  Print a long line\n"
	long = "\n" + strings.Repeat("─", 60) + "\n" + long + strings.Repeat("─", 60) + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	s, ok = parsePromptScreen(long)
	require.True(t, ok)
	assert.True(t, s.OnlyReject)
	assert.True(t, s.Unreadable, "longer than a card shows")

	// read whole, with a character that hides what it does: reject only, and the No stays
	hidden := "\n" + strings.Repeat("─", 60) + "\n  echo ok\u202e\n  Print a line\n" + strings.Repeat("─", 60) + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	s, ok = parsePromptScreen(hidden)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a hidden character: only a reject is offered")
	assert.False(t, s.Unreadable, "it was read whole, so the No stays (#15140)")
	assert.Contains(t, s.Note, "can only be rejected")

	// an ordinary request is neither
	plain := "\n" + strings.Repeat("─", 60) + "\n  echo ok\n  Print a line\n" + strings.Repeat("─", 60) + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
	s, ok = parsePromptScreen(plain)
	require.True(t, ok)
	assert.False(t, s.OnlyReject || s.Unreadable)

	// Hermes cut the command short on its own screen and nothing stored matches
	hs, ok := parsePromptScreen(hermesCutScreen("rm -rf /home/tester/dangerdir/" + strings.Repeat("over_the_cap_segment_001_", 7)))
	require.True(t, ok)
	applyHermesCommand(&hs, "")
	assert.True(t, hs.OnlyReject && hs.Unreadable, "a cut Hermes could not match to a stored command was not read in full")
}
