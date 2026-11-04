//go:build !windows

package ptymanager

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/naming"
)

// A dead pipe may leave an existing, empty log after a wake. That file's
// existence does not prove that an attached viewer will receive new output.
func TestTmuxAttachRepairsDeadPipeWithExistingEmptyLog(t *testing.T) {
	b := newTestTmuxBackend(t)
	const name, sid = "pipe-repair", "sid-pipe-repair"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), sid, "", 137, 42))
	t.Cleanup(func() { _ = b.Kill(name) })
	target := naming.SessionName("claude", sid)
	require.NoError(t, b.client.ClosePipePane(context.Background(), target))
	log := b.LogPath(name)
	require.NoError(t, os.WriteFile(log, nil, 0600))
	ch, err := b.Attach(name, "reconnected-viewer")
	require.NoError(t, err)
	defer b.Unsubscribe(name, "reconnected-viewer")
	piped, err := b.client.DisplayMessage(context.Background(), target, "#{pane_pipe}")
	require.NoError(t, err)
	require.Equal(t, "1", strings.TrimSpace(piped), "an existing empty file cannot suppress pipe reattachment")
	require.NoError(t, b.SendHumanInput(name, []byte("printf 'REPAIRED_PIPE_MARKER\\n'\r")))
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	var received string
	for !strings.Contains(received, "REPAIRED_PIPE_MARKER") {
		select {
		case data, ok := <-ch:
			require.True(t, ok, "attached stream stays open")
			received += string(data)
		case <-timeout.C:
			t.Fatal("new output never reached the attached stream after pipe repair")
		}
	}
	data, err := os.ReadFile(log)
	require.NoError(t, err)
	require.Contains(t, string(data), "REPAIRED_PIPE_MARKER", "repaired pipe writes the real log, not only a fallback capture")
}

// A transient failure to repair the pipe does not stop a person attaching (#13458, Lead's SHOULD B on #13421): only a terminal that is gone is an error; anything else is logged and the viewer attaches from
// the log as before.
func TestTmuxAttachCarriesOnWhenThePipeCannotBeChecked(t *testing.T) {
	b := newTestTmuxBackend(t)
	const name, sid = "pipe-hiccup", "sid-pipe-hiccup"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), sid, "", 137, 42))
	t.Cleanup(func() { _ = b.Kill(name) })
	blocker := t.TempDir() + "/afile"
	require.NoError(t, os.WriteFile(blocker, []byte("x"), 0600))
	b.mu.RLock()
	sess := b.sessions[name]
	b.mu.RUnlock()
	sess.logPath = blocker + "/session.log" // a log path that cannot be looked at (not a missing file): the pipe check fails with an ordinary error
	ch, err := b.Attach(name, "viewer")
	require.NoError(t, err, "a pipe check that fails for another reason than a gone terminal must not refuse the attach")
	require.NotNil(t, ch)
	b.Unsubscribe(name, "viewer")
}

func TestTmuxAttachToAGoneTerminalIsStillErrTerminalGone(t *testing.T) {
	b := newTestTmuxBackend(t)
	const name, sid = "pipe-gone", "sid-pipe-gone"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), sid, "", 137, 42))
	require.NoError(t, os.Remove(b.LogPath(name)))
	require.NoError(t, b.client.KillSessionOnly(context.Background(), name, "claude", sid))
	_, err := b.Attach(name, "viewer")
	require.ErrorIs(t, err, ErrTerminalGone)
}
