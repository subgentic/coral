package routes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14581 (Beta run 3, screenshot t12): Claude Code's own auto-block timer ('Claude Code will automatically block this request in 1:19, to avoid holding up an unattended session') is a line INSIDE its permission dialog and
// counts down on the terminal. Coral read it as part of the request, so (a) the card showed the time it was read at, frozen, and (b) the ask's identity (AskID, a digest of that text) changed every second: an answer carrying the id
// it was drawn for ('No') was refused as 'another ask is open' (prompt_answer.go), and the dialog stayed. The timer is Claude's, not Coral's: the card says so in fixed words, the same at every second.

// timerScreen is the layout of t12: the request between its rules, then Claude's own two lines under the closing rule, then the question.
func timerScreen(left string) string {
	rule := strings.Repeat("╌", 110)
	return "⏺ Bash(something)\n  ⎿  Waiting…\n\n" + strings.Repeat("─", 110) + "\n Bash command\n Run a long thing\n" + rule + "\n cat > /tmp/probe.txt <<'EOF'\n hello\n EOF\n" + rule +
		"\n| Dangerous rm operation not ruled out - the shell may read this command differently than it was parsed\n⚠ Claude Code will automatically block this request in " + left + ", to avoid holding up an unattended session\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n"
}

func TestClaudesAutoBlockTimerDoesNotChangeTheAskOrTheCard(t *testing.T) {
	var ids, targets []string
	for _, left := range []string{"1:19", "1:18", "0:59", "0:03"} {
		s, ok := parsePromptScreen(timerScreen(left))
		require.True(t, ok, left)
		ids, targets = append(ids, s.AskID), append(targets, s.Target)
		shown := s.Target + " " + s.TargetNote + " " + s.Question
		assert.NotContains(t, shown, left, "the card does not carry a time that is already wrong when it is read")
	}
	for i := 1; i < len(ids); i++ {
		assert.Equal(t, ids[0], ids[i], "the same ask a second later (a different id refuses the person's own answer): read %d", i)
		assert.Equal(t, targets[0], targets[i])
	}
}

func TestAnotherRequestIsStillAnotherAsk(t *testing.T) {
	a, _ := parsePromptScreen(timerScreen("1:19"))
	b, _ := parsePromptScreen(strings.Replace(timerScreen("1:19"), "probe.txt", "other.txt", 1))
	assert.NotEqual(t, a.AskID, b.AskID, "only the timer is made steady, not the command")
	// a command that CONTAINS Claude's whole line is shown unchanged: only the lines below the closing rule are Claude's
	phrase := "⚠ Claude Code will automatically block this request in 1:19, to avoid holding up an unattended session"
	c, ok := parsePromptScreen(claudeBashScreen(" cat > notes.txt <<'EOF'\n " + phrase + "\n EOF"))
	require.True(t, ok)
	assert.Contains(t, c.Target, "in 1:19", "inside the command block it is the command's own text")
	assert.NotContains(t, c.Target, "after a timer of its own")
	// a line that is not Claude's whole line is left alone below the rule too
	d, _ := parsePromptScreen(strings.Replace(timerScreen("1:19"), "⚠ Claude Code will automatically block this request in 1:19, to avoid holding up an unattended session", "Claude Code will automatically block this request in 1:19, and then something else", 1))
	assert.Contains(t, d.TargetNote+d.Target+d.Question, "in 1:19", "not the whole line: untouched")
	_ = fmt.Sprint
}
