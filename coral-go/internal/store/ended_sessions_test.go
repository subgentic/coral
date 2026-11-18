package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// Wake Team can name the agents Kill All ended (#14208): inactive rows of the board, newest per name, minus a name that is running or asleep again, an archived agent and other boards'.
func TestEndedSessionsOnBoardAreTheEndedAndNotStartedAgain(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	board := "ended-board"
	reg := func(id, name, b string) {
		t.Helper()
		n := name
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "proj", DisplayName: &n, WorkingDir: "/tmp/p", BoardName: &b}))
	}
	reg("e-lead", "Lead", board)
	reg("e-dev-old", "Dev", board)
	reg("e-dev-new", "Dev", board) // Dev was started again after its first session ended, then ended too
	reg("e-qa", "QA", board)       // QA is running again below
	reg("e-qa-again", "QA", board)
	reg("e-arch", "Archived", board)
	reg("e-other", "Other", "another-board")
	reg("e-live", "Live", board) // never ended
	for _, id := range []string{"e-lead", "e-dev-old", "e-qa", "e-arch", "e-other"} {
		require.NoError(t, ss.UnregisterLiveSession(ctx, id))
	}
	require.NoError(t, ss.UnregisterLiveSession(ctx, "e-dev-new"))
	require.NoError(t, ss.SetSessionArchived(ctx, "e-arch", true))

	got, err := ss.EndedSessionsOnBoard(ctx, board)
	require.NoError(t, err)
	names := map[string]string{}
	for _, e := range got {
		names[e.Name] = e.SessionID
	}
	require.Equal(t, map[string]string{"Lead": "e-lead", "Dev": "e-dev-new"}, names, "Lead and the newest Dev; QA runs again, Archived is archived, Other is another board's")
	order := make([]string, 0, len(got))
	for _, e := range got {
		order = append(order, e.Name)
	}
	require.Equal(t, []string{"Lead", "Dev"}, order, "in the order the team was started, not the order they were ended")
	none, err := ss.EndedSessionsOnBoard(ctx, "")
	require.NoError(t, err)
	require.Empty(t, none)
}

// #19696: Start brings an ended agent back by making its row a sleeping one; a name that is running again on the board is not taken from it, and a row that did not end is left alone.
func TestReviveEndedSessionMakesAnEndedRowSleepingAndKeepsNamesUnique(t *testing.T) {
	ss := autoSleepStore(t)
	ctx := context.Background()
	board := "revive-board"
	reg := func(id, name string) {
		t.Helper()
		n, b := name, board
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "proj", DisplayName: &n, WorkingDir: "/tmp/p", BoardName: &b}))
	}
	reg("r-dev", "Dev")
	reg("r-qa-old", "QA")
	reg("r-qa-new", "QA") // QA was started again
	reg("r-live", "Live") // never ended
	for _, id := range []string{"r-dev", "r-qa-old"} {
		require.NoError(t, ss.UnregisterLiveSession(ctx, id))
	}

	ok, err := ss.ReviveEndedSession(ctx, "r-dev")
	require.NoError(t, err)
	require.True(t, ok)
	ls, err := ss.GetLiveSession(ctx, "r-dev")
	require.NoError(t, err)
	require.Equal(t, "active", ls.Status)
	require.Equal(t, 1, ls.IsSleeping, "a sleeper a Start wakes")
	require.Nil(t, ls.StoppedAt)

	ok, err = ss.ReviveEndedSession(ctx, "r-qa-old")
	require.NoError(t, err)
	require.False(t, ok, "another QA runs on the board: its name is not taken from it")
	ok, err = ss.ReviveEndedSession(ctx, "r-live")
	require.NoError(t, err)
	require.False(t, ok, "a row that did not end is left alone")
}
