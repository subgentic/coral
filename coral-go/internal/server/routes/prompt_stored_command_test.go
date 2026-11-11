package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #15492 (the Operator, from the phone): a Bash request for `rm -rf $(cat ...)` offered only No, 'The top of this request is not on the screen'. The command was about 40 lines; the dialog was taller than
// the terminal, the opening rule was in no read (the pane's history or the PTY's ring), and under the closing rule Claude drew its warning ('Dangerous rm operation on statically-unresolvable target: command
// substitution output'). The request is still known whole: Claude's PreToolUse hook reported the call's command before it asked. When what is on the screen above the closing rule is the END of that command
// (whitespace and the dialog's side bar aside), the screen shows the dialog for that call and the stored command is the request: read whole, so Yes is offered. Anything that does not match stays Reject only.

func operatorCommand(n int) []string {
	var c []string
	for i := 1; i <= n; i++ {
		c = append(c, fmt.Sprintf("  step%02d --flag=%d $(cat $N/dir-%02d)", i, i, i))
	}
	return c
}

// operatorScreen is the screen of the walk: the last `visible` lines of the command with the dialog's side bar, the closing rule, the warning under it and the question.
func operatorScreen(cmd []string, visible int) string {
	rule := strings.Repeat("╌", 110)
	var b strings.Builder
	for _, l := range cmd[len(cmd)-visible:] {
		b.WriteString("│ " + strings.TrimLeft(l, " ") + "\n")
	}
	b.WriteString(rule + "\n│ Dangerous rm operation on statically-unresolvable target: command substitution output\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n")
	return b.String()
}

func storedRig(screen string, command string, tool string) *SessionsHandler {
	lt := &linesTerminal{mockSessionTerminal: newMockTerminal(), pane: screen}
	h := &SessionsHandler{terminal: lt}
	if command != "" {
		h.pending.set("sid", newPendingTool("toolu_1", tool, map[string]any{"command": command}, time.Now()))
	}
	return h
}

func readOperator(t *testing.T, h *SessionsHandler, agent string) promptScreen {
	t.Helper()
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", agent, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	return s
}

func TestARequestWhoseTopIsInNoReadIsReadWholeFromTheCallTheHookReported(t *testing.T) {
	cmd := operatorCommand(40)
	h := storedRig(operatorScreen(cmd, 12), strings.Join(cmd, "\n"), "Bash")
	s := readOperator(t, h, at.Claude)
	assert.False(t, s.OnlyReject, "the end of the command is on the screen and is the end of the call the hook reported: the request is whole and can be allowed: %s", s.Note)
	assert.Contains(t, s.Target, "step01 --flag=1", "the card shows the first line, which was on no screen")
	assert.Contains(t, s.Target, "step40 --flag=40", "and the last")
	assert.Contains(t, s.TargetNote+s.Question, "Do you want to proceed?")
	assert.False(t, s.commandOpenMissing)
}

func TestTheStoredCallIsOnlyUsedWhenTheScreenShowsItsEnd(t *testing.T) {
	cmd := operatorCommand(40)
	other := operatorCommand(40)
	other[35] = "  rm -rf /Users/someone/important"
	for name, stored := range map[string]string{
		"a command whose tail differs": strings.Join(other, "\n"),
		"a shorter command":            strings.Join(cmd[:20], "\n"),
	} {
		s := readOperator(t, storedRig(operatorScreen(cmd, 12), stored, "Bash"), at.Claude)
		assert.True(t, s.OnlyReject, name+": what is on the screen is not the end of the stored call: Reject only")
		assert.Contains(t, s.Note, "top of this request", name)
	}
}

func TestNoStoredCallOrAnotherToolKeepsTheRequestRejectOnly(t *testing.T) {
	cmd := operatorCommand(40)
	assert.True(t, readOperator(t, storedRig(operatorScreen(cmd, 12), "", ""), at.Claude).OnlyReject, "the hook reported nothing: no request to read")
	assert.True(t, readOperator(t, storedRig(operatorScreen(cmd, 12), strings.Join(cmd, "\n"), "Write"), at.Claude).OnlyReject, "a call of another tool is not a Bash request")
}

func TestAStoredCallIsOnlyUsedForAClaudeSession(t *testing.T) {
	cmd := operatorCommand(40)
	s := readOperator(t, storedRig(operatorScreen(cmd, 12), strings.Join(cmd, "\n"), "Bash"), at.Codex)
	assert.NotContains(t, s.Target, "step01", "another agent's program can print rules and a question of its own: no request is read from it")
}

func TestAShortTailOfTheScreenIsNotEnoughToTieItToTheStoredCall(t *testing.T) {
	cmd := append(operatorCommand(40), "  ls")
	s := readOperator(t, storedRig(operatorScreen(cmd, 1), strings.Join(cmd, "\n"), "Bash"), at.Claude)
	assert.True(t, s.OnlyReject, "one short line proves nothing about which call the dialog is for")
}

func TestAStoredCallThatIsTooLongOrHidesCharactersStaysRejectOnly(t *testing.T) {
	cmd := operatorCommand(40)
	hidden := append([]string{}, cmd...)
	hidden[3] = "  step04 \u202e --flag=4"
	s := readOperator(t, storedRig(operatorScreen(cmd, 12), strings.Join(hidden, "\n"), "Bash"), at.Claude)
	assert.True(t, s.OnlyReject, "the same limits judge the stored request: a hidden character in it is Reject only")
	long := append(append([]string{}, cmd...), strings.Repeat("x", 5000))
	long = append(long, cmd[len(cmd)-12:]...)
	s2 := readOperator(t, storedRig(operatorScreen(long, 12), strings.Join(long, "\n"), "Bash"), at.Claude)
	assert.True(t, s2.OnlyReject, "a request over the byte limit is Reject only")
}
