//go:build !windows

package ptymanager

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
	"github.com/subgentic/coral/internal/tmux"
)

// #390 / #389: the Unix pseudo-terminal backend records the agent's process too. A real pty with an interactive shell stands in for an agent's terminal and a long `sleep` for the CLI:
// before a launch line nothing is recorded, after one the process is recorded and notices are allowed while it is the foreground program, and once it has ended a program a person starts
// is not the agent. Not run where this was written (Windows): it is for the WSL / macOS runs.
func TestPTYBackendRecordsTheAgentAndAllowsNoticesOnlyWhileItIsTheForeground(t *testing.T) {
	canFork(t)
	t.Setenv("SHELL", "/bin/sh") // an interactive sh, with no profile of the person's
	backend := NewPTYBackend()
	t.Cleanup(func() { tmux.StopAgentWatches(); backend.Close() })
	const name = "notice-pty"

	require.NoError(t, backend.Spawn(name, "test", t.TempDir(), "sid-notice-pty", "", 80, 24))
	verdict := func() tmux.NoticeVerdict {
		v, ok := backend.AgentNoticeVerdict(name)
		require.True(t, ok, "the pty backend can tell: its shell pid is known")
		return v
	}
	wait := func(what string, cond func(tmux.NoticeVerdict) bool) {
		t.Helper()
		var last tmux.NoticeVerdict
		for end := time.Now().Add(30 * time.Second); time.Now().Before(end); time.Sleep(50 * time.Millisecond) {
			if last = verdict(); cond(last) {
				return
			}
		}
		t.Fatalf("%s: last verdict %+v", what, last)
	}

	assert.Equal(t, tmux.ReasonNotRecorded, verdict().Reason, "before any launch line nothing is recorded: nothing is typed")

	// The launch line: the "agent" starts in the foreground of the shell, and the backend records it.
	require.NoError(t, backend.SendLine(terminalinput.Unclassified, name, "sleep 120"))
	backend.AdoptAgent(name)
	wait("the agent's process is recorded and is the foreground program", func(v tmux.NoticeVerdict) bool { return v.OK })

	// It ends (Ctrl-C): the recorded process is gone, and then a program a person starts is not the agent.
	require.NoError(t, backend.SendInput(terminalinput.Unclassified, name, []byte{3}))
	wait("the recorded process has ended", func(v tmux.NoticeVerdict) bool { return v.Reason == tmux.ReasonGone })
	require.NoError(t, backend.SendLine(terminalinput.Unclassified, name, "sleep 119"))
	time.Sleep(1200 * time.Millisecond) // sleep-ok: a negative proof; past the process table cache, so the check reads a fresh table
	v := verdict()
	assert.False(t, v.OK, "a program a person started is not the recorded agent")
	assert.NotEqual(t, tmux.ReasonAdopting, v.Reason)

	// A new launch line records the next process.
	require.NoError(t, backend.SendInput(terminalinput.Unclassified, name, []byte{3}))
	time.Sleep(300 * time.Millisecond) // sleep-ok: the interrupt reaches the sleep before the next line is typed
	require.NoError(t, backend.SendLine(terminalinput.Unclassified, name, "sleep 118"))
	backend.AdoptAgent(name)
	wait("the new launch is recorded", func(v tmux.NoticeVerdict) bool { return v.OK })
}
