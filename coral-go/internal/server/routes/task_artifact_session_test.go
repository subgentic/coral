package routes

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

// #4098: a task with no agent session (completed by the API key, the command line or the
// dashboard) has no changes to persist: the writer isn't called and nothing is logged as a
// warning. A task with a session is still written, and a real failure still warns.
func TestTaskChangesOnlyForAgentSessions(t *testing.T) {
	var logged bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := &BoardHandler{}
	calls := 0
	h.SetTaskArtifactWriter(t.TempDir(), func(context.Context, *board.Task, string) error {
		calls++
		return errors.New("could not determine working directory")
	})
	empty := ""
	for _, task := range []*board.Task{{ID: 1}, {ID: 2, SessionID: &empty}} {
		h.persistTaskArtifact(context.Background(), task)
	}
	if calls != 0 || strings.Contains(logged.String(), "level=WARN") {
		t.Fatalf("no session: writer called %d times, log %q", calls, logged.String())
	}
	sid := "aaaaaaaa-0000-4000-8000-000000004098"
	h.persistTaskArtifact(context.Background(), &board.Task{ID: 3, SessionID: &sid})
	if calls != 1 || !strings.Contains(logged.String(), "persist task changes artifact failed") {
		t.Fatalf("with a session: writer called %d times, log %q", calls, logged.String())
	}
}

// #16554 (walk 24, finding 9): the agent's folder is not a git repository (a team folder that is no repo): there are no changes to diff, so it is a debug line, not a warning; a real
// failure still warns.
func TestTaskChangesNotAGitRepoIsNotAWarning(t *testing.T) {
	var logged bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	sid := "aaaaaaaa-0000-4000-8000-000000016554"
	h := &BoardHandler{}
	var failure error = fmt.Errorf("%w: /work/team", errNotGitRepo)
	h.SetTaskArtifactWriter(t.TempDir(), func(context.Context, *board.Task, string) error { return failure })
	h.persistTaskArtifact(context.Background(), &board.Task{ID: 4, SessionID: &sid})
	if strings.Contains(logged.String(), "level=WARN") || strings.Contains(logged.String(), "persist task changes artifact failed") {
		t.Fatalf("not a git repository warned: %q", logged.String())
	}
	failure = errors.New("git diff: exit status 128: fatal: bad object")
	h.persistTaskArtifact(context.Background(), &board.Task{ID: 5, SessionID: &sid})
	if !strings.Contains(logged.String(), "persist task changes artifact failed") {
		t.Fatalf("a real failure must still warn: %q", logged.String())
	}
}

// PersistTaskChanges itself says errNotGitRepo, before any git diff runs, for a session whose folder is no git repository.
func TestPersistTaskChangesNotAGitRepo(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "aaaaaaaa-0000-4000-8000-000000016555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "plain", WorkingDir: t.TempDir()}))
	err := h.PersistTaskChanges(ctx, &board.Task{ID: 6, SessionID: &sid}, filepath.Join(t.TempDir(), "changes.diff"))
	require.ErrorIs(t, err, errNotGitRepo)
}
