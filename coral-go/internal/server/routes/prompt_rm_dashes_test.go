package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15140 (Beta walk 4, finding 2): a Bash rm prompt whose request cannot be shown whole (its opening rule is not on the screen) showed ROWS OF DASHES as the command: the three lines above the question
// were Claude's dashed rule and its own two lines, and the card showed them as "what it wants to run". A card never shows a rule as the request, and it says when Claude Code blocks the request by itself.

func rmScreenWithoutTop(left string) string {
	rule := strings.Repeat("╌", 110)
	return "  rm -rf /tmp/probe-dir\n  Remove the probe directory\n" + rule + "\n| Dangerous rm operation not ruled out - the shell may read this command differently than it was parsed\n⚠ Claude Code will automatically block this request in " + left + ", to avoid holding up an unattended session\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n"
}

func TestARequestCutAtTheTopNeverShowsARuleAsTheCommand(t *testing.T) {
	s, ok := parsePromptScreen(rmScreenWithoutTop("0:42"))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "its opening rule is not on the screen: Reject only")
	assert.NotContains(t, s.Target, "╌", "no row of dashes is shown as what it wants to run")
	assert.Contains(t, s.Target, "Dangerous rm operation not ruled out", "Claude's own line stays, as Claude's")
}

func TestTheCardSaysWhenClaudeBlocksTheRequestItself(t *testing.T) {
	before := time.Now()
	s, ok := parsePromptScreen(rmScreenWithoutTop("0:42"))
	require.True(t, ok)
	at, err := time.Parse(time.RFC3339, s.AutoBlockAt)
	require.NoError(t, err, "the time Claude Code's timer ends is on the card: %q", s.AutoBlockAt)
	assert.WithinDuration(t, before.Add(42*time.Second), at, 3*time.Second)
	a, _ := parsePromptScreen(rmScreenWithoutTop("0:42"))
	b, _ := parsePromptScreen(rmScreenWithoutTop("0:11"))
	assert.Equal(t, a.AskID, b.AskID, "the time left is display only: it is never part of the ask's identity")
	none, _ := parsePromptScreen(strings.Replace(rmScreenWithoutTop("0:42"), "⚠ Claude Code will automatically block this request in 0:42, to avoid holding up an unattended session\n", "", 1))
	assert.Equal(t, "", none.AutoBlockAt, "a screen with no timer says none")
}
