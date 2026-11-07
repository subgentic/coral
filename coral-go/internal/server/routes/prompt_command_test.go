package routes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14173 (the Beta Tester): a long command showed only its last lines, because the prompt's context was three lines. A permission prompt draws its request between two dashed rules; the whole block is the target.
func claudeBashScreen(command string) string {
	rule := strings.Repeat("╌", 110)
	return "⏺ Bash(something)\n  ⎿  Waiting…\n\n" + strings.Repeat("─", 110) + "\n Bash command\n Run a long thing\n" + rule + "\n" + command + "\n" + rule + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n"
}

func TestPermissionTarget_IsTheWholeBlockBetweenTheRules(t *testing.T) {
	var lines []string
	for i := 1; i <= 14; i++ {
		lines = append(lines, fmt.Sprintf(" step%02d --flag=%d", i, i))
	}
	s, ok := parsePromptScreen(claudeBashScreen(strings.Join(lines, "\n")))
	require.True(t, ok)
	assert.False(t, s.OnlyReject)
	for i := 1; i <= 14; i++ {
		assert.Contains(t, s.Target, fmt.Sprintf("step%02d --flag=%d", i, i), "line %d of the command is in the target", i)
	}
	assert.NotContains(t, s.Target, "╌", "the rules are not part of the command")
	assert.Equal(t, 14, len(strings.Split(s.Target, "\n")))

	one, ok := parsePromptScreen(claudeBashScreen(" touch probe.txt"))
	require.True(t, ok)
	assert.Equal(t, "touch probe.txt", one.Target)

	// the ask is still told from the next one by its last lines: the same command with another first line is the same ask (context is unchanged), another last line is another ask
	other := strings.Replace(strings.Join(lines, "\n"), "step14 --flag=14", "step14 --flag=99", 1)
	s2, _ := parsePromptScreen(claudeBashScreen(other))
	assert.NotEqual(t, s.AskID, s2.AskID)

	// a screen with no dashed rules keeps the old three lines and a Target as before
	plain, ok := parsePromptScreen("some output\nmore output\nrun it?\n ❯ 1. Yes\n   2. No\n")
	require.True(t, ok)
	assert.Empty(t, plain.command)
}

func TestPermissionTarget_AHiddenCharacterInAnEarlyLineIsJudged(t *testing.T) {
	cmd := " echo safe\n echo ‮evil\n echo one\n echo two\n echo three"
	s, ok := parsePromptScreen(claudeBashScreen(cmd))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a hidden character four lines up was never judged before; the whole block is now")
}

func TestPermissionTarget_TooLongIsOnlyReject(t *testing.T) {
	big := strings.Repeat(" echo "+strings.Repeat("x", 80)+"\n", 60)
	s, ok := parsePromptScreen(claudeBashScreen(strings.TrimRight(big, "\n")))
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a request longer than the card shows can only be rejected")
}

// Security's SHOULD on #14173: a closing dashed rule with no opening rule in reach is a request that cannot be read whole: only Reject.
func TestPermissionTarget_NoOpeningRuleIsOnlyReject(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	screen := "⏺ Bash(x)\n" + strings.Repeat(" more output\n", 3) + " touch a\n" + rule + "\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	s, ok := parsePromptScreen(screen)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "the opening rule is not on the screen")
	assert.Contains(t, s.Note, "top of this request")
}
