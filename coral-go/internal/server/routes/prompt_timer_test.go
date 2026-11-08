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

func timerScreen(left string) string {
	cmd := " cat > /tmp/probe.txt <<'EOF'\n hello\n EOF\n| Dangerous rm operation not ruled out - the shell may read this command differently than it was parsed\n⚠ Claude Code will automatically block this request in " + left + ", to avoid holding up an unattended session"
	return claudeBashScreen(cmd)
}

func TestClaudesAutoBlockTimerDoesNotChangeTheAskOrTheCard(t *testing.T) {
	var ids, targets []string
	for _, left := range []string{"1:19", "1:18", "0:59", "0:03"} {
		s, ok := parsePromptScreen(timerScreen(left))
		require.True(t, ok, left)
		ids, targets = append(ids, s.AskID), append(targets, s.Target)
		assert.NotContains(t, s.Target, left, "the card does not carry a time that is already wrong when it is read")
		assert.Contains(t, s.Target, "Claude Code will automatically block this request", "Claude's line is still shown")
		assert.Contains(t, s.Target, "after a timer of its own", "as Claude's own timer, in fixed words")
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
	c, _ := parsePromptScreen(claudeBashScreen(" touch x\n a line that says in 1:19 but is the command's own"))
	assert.Contains(t, c.Target, "in 1:19", "a time in text that is not Claude's timer line is left alone")
	_ = fmt.Sprint
}
