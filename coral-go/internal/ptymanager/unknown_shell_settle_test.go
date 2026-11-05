package ptymanager

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13658: a freshly created pane's shell is still starting, and a child shell of its startup is for a moment what the process walk calls a shell of unknown contents. A launch looks again for a short window
// before it refuses; a shell that stays is still refused.

// startupTerminal names a shell for the first `named` looks and none after: the startup child that goes away.
type startupTerminal struct {
	named int32
	looks atomic.Int32
	shell string
}

func (s *startupTerminal) AgentUnknownShell(context.Context, string, string, string) (string, bool) {
	if s.looks.Add(1) <= s.named {
		return s.shell, true
	}
	return "", true
}

func fastSettle(t *testing.T, window, poll time.Duration) {
	t.Helper()
	t.Cleanup(SetUnknownShellSettle(window, poll))
}

func TestAStartupChildShellThatGoesAwayIsNotRefused(t *testing.T) {
	fastSettle(t, 2*time.Second, 5*time.Millisecond)
	term := &startupTerminal{named: 4, shell: "/bin/zsh"} // four looks land in the startup, the fifth finds the prompt
	assert.Equal(t, "", SettledUnknownShell(t.Context(), term, "claude-x", "", ""), "the shell settled: no refusal")
	assert.EqualValues(t, 5, term.looks.Load(), "it looked again until the shell was gone, and no more")
	// and the one-look function the guard is built on still sees what it saw: the first look is unchanged
	term2 := &startupTerminal{named: 1, shell: "/bin/zsh"}
	assert.Equal(t, "/bin/zsh", UnknownShell(t.Context(), term2, "claude-x", "", ""))
}

func TestAShellThatStaysIsStillRefusedAfterTheWindow(t *testing.T) {
	fastSettle(t, 120*time.Millisecond, 10*time.Millisecond)
	term := &startupTerminal{named: 1 << 30, shell: "bash"} // a person's shell, there for good
	start := time.Now()
	assert.Equal(t, "bash", SettledUnknownShell(t.Context(), term, "claude-x", "", ""), "a shell that stays is refused: the guard's rule is unchanged")
	assert.GreaterOrEqual(t, time.Since(start), 100*time.Millisecond, "after the window, not at the first look")
	assert.Less(t, time.Since(start), 2*time.Second)
	assert.Greater(t, term.looks.Load(), int32(2), "it looked more than once")
}

func TestNothingNamedIsOneLookAndNoWait(t *testing.T) {
	fastSettle(t, 2*time.Second, 5*time.Millisecond)
	term := &startupTerminal{named: 0}
	start := time.Now()
	assert.Equal(t, "", SettledUnknownShell(t.Context(), term, "claude-x", "", ""))
	assert.EqualValues(t, 1, term.looks.Load(), "one look")
	assert.Less(t, time.Since(start), 500*time.Millisecond, "no waiting when nothing is named (the common case)")
	assert.Equal(t, "", SettledUnknownShell(t.Context(), struct{}{}, "claude-x", "", ""), "a terminal that cannot tell has nothing named")
}

func TestACancelledLaunchStopsWaitingAndKeepsTheLastLook(t *testing.T) {
	fastSettle(t, 5*time.Second, 20*time.Millisecond)
	term := &startupTerminal{named: 1 << 30, shell: "bash"}
	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(80*time.Millisecond, cancel)
	start := time.Now()
	require.Equal(t, "bash", SettledUnknownShell(ctx, term, "claude-x", "", ""), "the last look stands: a launch whose caller left is still refused")
	assert.Less(t, time.Since(start), 2*time.Second, "and it did not wait the whole window")
}
