package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #14575 (Beta run 3): a Bash request of about 90 lines showed 'The top of this request is not on the screen ... It can only be rejected here', and nobody could allow it, because the prompt was read from the LAST 80 lines of the
// pane and the request's opening dashed rule was farther up. The parser walks up to commandMaxLines (400) for it, so the window is the limit: when the first read misses the opening rule, the pane is read again deeper, and the
// same checks (the dialog header, the 4000-byte limit, hidden characters) then judge what is found. A request whose top is still not there stays Reject only.

// linesTerminal answers CaptureOutput as tmux does: the last `lines` lines of the pane (history included).
type linesTerminal struct {
	*mockSessionTerminal
	pane  string
	asked []int
}

func (l *linesTerminal) CaptureOutput(_ context.Context, _ string, lines int, _, _ string) (string, error) {
	l.asked = append(l.asked, lines)
	all := strings.Split(l.pane, "\n")
	if lines < len(all) {
		all = all[len(all)-lines:]
	}
	return strings.Join(all, "\n"), nil
}

func deepRig(pane string) (*SessionsHandler, *linesTerminal) {
	lt := &linesTerminal{mockSessionTerminal: newMockTerminal(), pane: pane}
	return &SessionsHandler{terminal: lt}, lt
}

func longCommand(n int) string {
	var b []string
	for i := 1; i <= n; i++ {
		b = append(b, fmt.Sprintf(" echo line%03d >> /tmp/probe.txt", i))
	}
	return strings.Join(b, "\n")
}

func TestARequestWhoseTopIsAboveTheFirstWindowIsReadWhole(t *testing.T) {
	pane := strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95)) // about 95 lines of command: over the 80-line window, under 4000 bytes
	h, lt := deepRig(pane)
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.False(t, s.OnlyReject, "the top is in the pane's history: the request is read whole and the person can allow it: %s", s.Note)
	assert.Contains(t, s.Target, "line001", "the first line of the command is in what the card shows")
	assert.Contains(t, s.Target, "line095", "and the last")
	assert.Equal(t, []int{80, deepPromptCaptureLines}, lt.asked, "the pane is read again, deeper, only because the first read missed the top")
}

func TestARequestThatFitsTheFirstWindowIsReadOnce(t *testing.T) {
	h, lt := deepRig(claudeBashScreen(longCommand(5)))
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.False(t, s.OnlyReject)
	assert.Equal(t, []int{80}, lt.asked, "no deeper read when the top was found")
}

func TestARequestWhoseTopIsNowhereInThePaneStaysRejectOnly(t *testing.T) {
	rule := strings.Repeat("╌", 110)
	pane := strings.Repeat(" more output\n", 200) + longCommand(10) + "\n" + rule + "\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"
	h, _ := deepRig(pane)
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "a request that was never shown whole can only be rejected, however deep the read")
	assert.Contains(t, s.Note, "top of this request")
}

func TestADeeperReadStillJudgesTheRequestByTheSameLimits(t *testing.T) {
	big := strings.Repeat(" echo "+strings.Repeat("x", 80)+"\n", 100) // 100 lines, over 4000 bytes
	h, _ := deepRig(claudeBashScreen(strings.TrimRight(big, "\n")))
	s, ok, _, err := h.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err)
	require.True(t, ok)
	assert.True(t, s.OnlyReject, "found whole but over the byte limit: still Reject only")
	hidden := strings.Replace(longCommand(95), "line010", "line‮010", 1)
	h2, _ := deepRig(claudeBashScreen(hidden))
	s2, ok2, _, err2 := h2.readPromptScreenText(context.Background(), "a", at.Claude, "sid")
	require.NoError(t, err2)
	require.True(t, ok2)
	assert.True(t, s2.OnlyReject, "a hidden character in a line the first window never saw is judged too")
}

func TestADeeperReadIsForClaudeOnly(t *testing.T) {
	h, lt := deepRig(strings.Repeat("older output\n", 30) + claudeBashScreen(longCommand(95)))
	_, _, _, err := h.readPromptScreenText(context.Background(), "a", at.Codex, "sid")
	require.NoError(t, err)
	assert.Equal(t, []int{80}, lt.asked, "another agent's program can print rules of its own: no deeper read, no request read from it")
}
