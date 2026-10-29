package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func seatMember(t *testing.T, s *TeamStore, team, agent, sid string) *TeamMember {
	t.Helper()
	ctx := context.Background()
	tm, err := s.GetTeam(ctx, team)
	require.NoError(t, err)
	if tm == nil {
		tm, err = s.CreateTeam(ctx, &Team{Name: team, ConfigJSON: `{}`})
		require.NoError(t, err)
	}
	m, err := s.CreateTeamMember(ctx, &TeamMember{TeamID: tm.ID, AgentName: agent, AgentConfigJSON: `{}`, SessionID: &sid})
	require.NoError(t, err)
	return m
}

func TestSearchReach_DefaultsToOwn(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	seatMember(t, s, "b-one", "Dev", "sid-1")

	got, err := s.SearchReachForSession(ctx, "sid-1")
	require.NoError(t, err)
	assert.Equal(t, "own", got)

	// A session with no member row is never above own.
	got, err = s.SearchReachForSession(ctx, "no-such-session")
	require.NoError(t, err)
	assert.Equal(t, "own", got)
}

func TestSearchReach_SetLogsTheRaiseAndFollowsTheSession(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	seatMember(t, s, "b-one", "Dev", "sid-1")

	from, err := s.SetSearchReach(ctx, "b-one", "Dev", "team", "operator", "dashboard")
	require.NoError(t, err)
	assert.Equal(t, "own", from)

	got, _ := s.SearchReachForSession(ctx, "sid-1")
	assert.Equal(t, "team", got)

	rows, err := s.ListSearchAccess(ctx, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "raise", rows[0].Kind)
	assert.Equal(t, "own", rows[0].FromLevel)
	assert.Equal(t, "team", rows[0].ToLevel)
	assert.Equal(t, "Dev", rows[0].Agent)
	assert.Equal(t, "b-one", rows[0].Team)
}

func TestSearchReach_RejectsUnknownLevelAndMember(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	seatMember(t, s, "b-one", "Dev", "sid-1")

	_, err := s.SetSearchReach(ctx, "b-one", "Dev", "root", "operator", "dashboard")
	assert.ErrorIs(t, err, ErrInvalidSearchReach)
	_, err = s.SetSearchReach(ctx, "b-one", "Ghost", "team", "operator", "dashboard")
	assert.Error(t, err)

	got, _ := s.SearchReachForSession(ctx, "sid-1")
	assert.Equal(t, "own", got)
	rows, _ := s.ListSearchAccess(ctx, 10)
	assert.Empty(t, rows, "a refused change leaves no log row")
}

func TestSearchReach_ResetToOwn(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	m := seatMember(t, s, "b-one", "Dev", "sid-1")
	_, err := s.SetSearchReach(ctx, "b-one", "Dev", "all", "operator", "dashboard")
	require.NoError(t, err)

	require.NoError(t, s.ResetSearchReach(ctx, m.TeamID))
	got, _ := s.SearchReachForSession(ctx, "sid-1")
	assert.Equal(t, "own", got)
}

func TestSearchAccessLog_ReadRowsCarryNoText(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, s.LogSearchRead(ctx, "b-one", "Dev", "team", "ok", 3))
	rows, err := s.ListSearchAccess(ctx, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "read", rows[0].Kind)
	assert.Equal(t, "team", rows[0].ToLevel)
	assert.Equal(t, 3, rows[0].Results)
}

func TestSearchAccessLog_Retention(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()

	old := time.Now().UTC().AddDate(0, 0, -91).Format(ISOFormat)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO search_access_log (kind, team, agent, from_level, to_level, outcome, results, at) VALUES ('read','b','A','','team','ok',0,?)`, old)
	require.NoError(t, err)
	require.NoError(t, s.LogSearchRead(ctx, "b", "A", "team", "ok", 1))
	require.NoError(t, s.PruneSearchAccess(ctx))
	rows, _ := s.ListSearchAccess(ctx, 100)
	assert.Len(t, rows, 1, "a row older than 90 days is gone")

	for i := 0; i < SearchAccessMaxRows+25; i++ {
		_, err := s.db.ExecContext(ctx,
			`INSERT INTO search_access_log (kind, team, agent, from_level, to_level, outcome, results, at) VALUES ('read','b',?,'','team','ok',0,?)`,
			fmt.Sprintf("A%d", i), time.Now().UTC().Format(ISOFormat))
		require.NoError(t, err)
	}
	require.NoError(t, s.PruneSearchAccess(ctx))
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM search_access_log`))
	assert.Equal(t, SearchAccessMaxRows, n)
}
