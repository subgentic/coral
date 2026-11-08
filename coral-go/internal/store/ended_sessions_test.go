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
