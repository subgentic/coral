package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11112: a seat is foreign when the session it belongs to was launched on another board (its live row says which): the leftover of the hole #11013 closed, where an agent seated itself or an agent it started on
// another team's board. The Operator needs to find them to remove them.
func TestForeignSeatsAreTheSeatsOfSessionsLaunchedElsewhere(t *testing.T) {
	s, sessDB := testStoreWithSessionsDB(t)
	ctx := context.Background()
	a, err := s.CreateBoard(ctx, "team-a", "Operator")
	require.NoError(t, err)
	b, err := s.CreateBoard(ctx, "team-b", "Operator")
	require.NoError(t, err)
	live := func(sid, typ, name string, board *string) {
		sessDB.MustExec(`INSERT INTO live_sessions (session_id, agent_type, agent_name, working_dir, board_name) VALUES (?, ?, ?, '/w', ?)`, sid, typ, name, board)
	}
	const (
		wanderer = "aaaaaaaa-1112-4000-8000-000000000001" // launched on team-a, also seated on team-b
		home     = "aaaaaaaa-1112-4000-8000-000000000002" // launched on team-a, seated on team-a only
		solo     = "aaaaaaaa-1112-4000-8000-000000000003" // launched on no board
	)
	live(wanderer, "claude", "wanderer", &a.ID)
	live(home, "claude", "home", &a.ID)
	live(solo, "claude", "solo", nil)
	seat := func(board, id, sid string) {
		_, err := s.Subscribe(ctx, board, id, "Role "+id, "claude-"+sid, nil, "all")
		require.NoError(t, err)
	}
	seat(a.ID, "Wanderer", wanderer)
	seat(b.ID, "Wanderer", wanderer) // the foreign one
	seat(a.ID, "Home", home)
	seat(b.ID, "Solo", solo)
	_, err = s.Subscribe(ctx, b.ID, "Operator", "Operator", "", nil, "all") // no session: the Operator's own
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, b.ID, "Gone", "Gone", "claude-aaaaaaaa-1112-4000-8000-0000000000ff", nil, "all") // its session has no live row any more
	require.NoError(t, err)

	got, err := s.ForeignSeats(ctx)
	require.NoError(t, err)
	require.Len(t, got, 1, "%+v", got)
	f := got[0]
	assert.Equal(t, b.ID, f.BoardID)
	assert.Equal(t, "team-b", f.BoardLabel)
	assert.Equal(t, "Wanderer", f.SubscriberID)
	assert.Equal(t, wanderer, f.SessionID)
	assert.Equal(t, "wanderer", f.AgentName)
	assert.Equal(t, a.ID, f.LaunchBoard)
	assert.Equal(t, "team-a", f.LaunchBoardLabel)

	// Once the seat is removed it is no longer listed.
	removed, err := s.Unsubscribe(ctx, b.ID, "Wanderer")
	require.NoError(t, err)
	require.True(t, removed)
	got, err = s.ForeignSeats(ctx)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestForeignSeatsWithNoSessionsDBIsEmpty(t *testing.T) {
	s := testStore(t)
	got, err := s.ForeignSeats(context.Background())
	require.NoError(t, err)
	assert.Empty(t, got)
}
