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

func TestWakeDoesNotHideFailureToRestoreRetainedTmuxLogging(t *testing.T) {
	_, h, term, _ := setupSessionsTestServer(t)
	ctx := context.Background()
	require.NoError(t, term.CreateSession(ctx, "retained-pane", t.TempDir()))
	h.terminal = &wakeLoggingRefusal{term}
	launched := false
	err := h.startWake(ctx, &store.LiveSession{AgentType: "terminal"}, &wakePlan{sessionName: "retained-pane", backend: "tmux", logFile: filepath.Join(t.TempDir(), "terminal.log")}, &launched)
	require.ErrorContains(t, err, "restore wake logging: pipe unavailable")
	require.False(t, launched)
}
