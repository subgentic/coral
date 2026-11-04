package routes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

func TestWakeRetainedTmuxPaneRestoresLoggingWithoutErasingHistory(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	const name = "retained-pane"
	require.NoError(t, term.CreateSession(ctx, name, t.TempDir()))
	path := filepath.Join(t.TempDir(), "terminal.log")
	require.NoError(t, os.WriteFile(path, []byte("history remains\r\n"), 0600))
	var logged int
	term.onCall = func(method string) {
		if method == "StartLogging" {
			logged++
		}
	}
	launched := false
	err := h.startWake(ctx, &store.LiveSession{AgentType: "terminal"}, &wakePlan{sessionName: name, backend: "tmux", logFile: path}, &launched)
	require.NoError(t, err)
	require.Equal(t, 1, logged, "retaining the pane must not skip restoring its pipe")
	require.False(t, launched, "logging repair does not restart the existing program")
	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, "history remains\r\n", string(got))
}

type wakeLoggingRefusal struct{ *mockSessionTerminal }

func (t *wakeLoggingRefusal) StartLogging(context.Context, string, string) error {
	return errors.New("pipe unavailable")
}

// A retained pane whose log pipe cannot be restored does not fail the wake (#13458, Lead's SHOULD A on #13421): the agent is running, so it is woken (the flag clears, the program is not restarted)
// and the failure is a warning; the viewer's reconnect repairs the pipe.
func TestWakeCarriesOnWhenItCannotRestoreRetainedTmuxLogging(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	require.NoError(t, term.CreateSession(ctx, "retained-pane", t.TempDir()))
	h.terminal = &wakeLoggingRefusal{term}
	launched := false
	err := h.startWake(ctx, &store.LiveSession{AgentType: "terminal"}, &wakePlan{sessionName: "retained-pane", backend: "tmux", logFile: filepath.Join(t.TempDir(), "terminal.log")}, &launched)
	require.NoError(t, err, "a logging failure must never fail the wake")
	require.False(t, launched, "the running program is not restarted")
}

// The same for the log file that cannot be prepared.
func TestWakeCarriesOnWhenItCannotPrepareTheRetainedPanesLogFile(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	require.NoError(t, term.CreateSession(ctx, "retained-pane", t.TempDir()))
	blocker := filepath.Join(t.TempDir(), "afile")
	require.NoError(t, os.WriteFile(blocker, []byte("x"), 0600))
	launched := false
	err := h.startWake(ctx, &store.LiveSession{AgentType: "terminal"}, &wakePlan{sessionName: "retained-pane", backend: "tmux", logFile: filepath.Join(blocker, "terminal.log")}, &launched)
	require.NoError(t, err, "a log file that cannot be made must never fail the wake")
	require.False(t, launched)
}
