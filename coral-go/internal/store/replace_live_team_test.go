package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A restarted agent's new live row keeps its team (#11048): the board sets of a search level are joined through live_sessions.team_id, and a search trusts a member row only when its live row names the same team,
// so a restart that dropped team_id would take the agent out of its own team's reach.
func TestReplaceLiveSessionKeepsTheTeam(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ts := NewTeamStore(db)
	ctx := context.Background()
	team, err := ts.CreateTeam(ctx, &Team{Name: "t", ConfigJSON: `{}`})
	require.NoError(t, err)
	board := "b-abcdefghij"
	require.NoError(t, ss.RegisterLiveSession(ctx, &LiveSession{SessionID: "old-1", AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &board}))
	require.NoError(t, ss.SetTeamID(ctx, "old-1", team.ID))

	require.NoError(t, ss.ReplaceLiveSession(ctx, "old-1", &LiveSession{SessionID: "new-1", AgentType: "claude", AgentName: "dev", WorkingDir: "/w", BoardName: &board}))
	got, err := ss.GetLiveSession(ctx, "new-1")
	require.NoError(t, err)
	require.NotNil(t, got)
	require.NotNil(t, got.TeamID, "the new row has the team of the one it replaced")
	assert.Equal(t, team.ID, *got.TeamID)
}
