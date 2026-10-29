package store

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
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
	m := seatMember(t, s, "b-one", "Dev", "sid-1")

	from, err := s.SetSearchReach(ctx, m.ID, "team", "operator", "dashboard")
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
	m := seatMember(t, s, "b-one", "Dev", "sid-1")

	_, err := s.SetSearchReach(ctx, m.ID, "root", "operator", "dashboard")
	assert.ErrorIs(t, err, ErrInvalidSearchReach)
	_, err = s.SetSearchReach(ctx, m.ID+999, "team", "operator", "dashboard")
	assert.ErrorIs(t, err, sql.ErrNoRows)

	got, _ := s.SearchReachForSession(ctx, "sid-1")
	assert.Equal(t, "own", got)
	rows, _ := s.ListSearchAccess(ctx, 10)
	assert.Empty(t, rows, "a refused change leaves no log row")
}

// A team deleted and made again under the same name is a different team: the old member's id reaches nothing, and the new same-named member is untouched.
func TestSearchReach_AStaleMemberIDDoesNotReachANewTeamOfTheSameName(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	old := seatMember(t, s, "b-one", "Dev", "sid-old")
	tm, err := s.GetTeam(ctx, "b-one")
	require.NoError(t, err)
	require.NoError(t, s.UpdateTeamStatus(ctx, tm.ID, "stopped")) // only a stopped team is deleted
	require.NoError(t, s.DeleteTeam(ctx, tm.ID))
	fresh := seatMember(t, s, "b-one", "Dev", "sid-new")
	require.NotEqual(t, old.ID, fresh.ID)

	_, err = s.SetSearchReach(ctx, old.ID, "all", "operator", "dashboard")
	assert.ErrorIs(t, err, sql.ErrNoRows)
	got, _ := s.SearchReachForSession(ctx, "sid-new")
	assert.Equal(t, "own", got)
}

func TestSearchAccessLog_ReadRowsCarryNoText(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	require.NoError(t, s.LogSearchRead(ctx, "b-one", "Dev", "team", "ok", "board-search", "b-one", 3))
	rows, err := s.ListSearchAccess(ctx, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "read", rows[0].Kind)
	assert.Equal(t, "team", rows[0].ToLevel)
	assert.Equal(t, 3, rows[0].Results)
	assert.Equal(t, "board-search", rows[0].Action)
	assert.Equal(t, "b-one", rows[0].Target)
}

func TestSearchAccessLog_Retention(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()

	old := time.Now().UTC().AddDate(0, 0, -91).Format(ISOFormat)
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO search_access_log (kind, team, agent, from_level, to_level, outcome, results, at) VALUES ('read','b','A','','team','ok',0,?)`, old)
	require.NoError(t, err)
	require.NoError(t, s.LogSearchRead(ctx, "b", "A", "team", "ok", "board-search", "b", 1))
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

// A member row is made at own whatever the caller's struct carries: a launch from a template, a clone or an import never brings a level with it (#11048).
func TestSearchReach_ANewMemberRowStartsAtOwn(t *testing.T) {
	s := NewTeamStore(openTestDB(t))
	ctx := context.Background()
	tm, err := s.CreateTeam(ctx, &Team{Name: "b-clone", ConfigJSON: `{}`})
	require.NoError(t, err)
	sid := "sid-clone"
	m, err := s.CreateTeamMember(ctx, &TeamMember{TeamID: tm.ID, AgentName: "Dev", AgentConfigJSON: `{"search_reach":"operator"}`, SearchReach: "all", SessionID: &sid})
	require.NoError(t, err)
	got, err := s.SearchReachForSession(ctx, sid)
	require.NoError(t, err)
	assert.Equal(t, "own", got, "neither the struct's level nor one in the agent config is read")
	assert.Equal(t, "own", m.SearchReach, "and the row the caller gets back says so")
}

// Only CreateTeamMember makes a member row, so no restore, copy or import path can carry a level in (#11048, Security's SHOULD b).
func TestSearchReach_OnlyCreateTeamMemberInsertsMemberRows(t *testing.T) {
	var inserts []string
	require.NoError(t, filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		raw, rerr := os.ReadFile(path)
		require.NoError(t, rerr)
		if strings.Contains(strings.ToLower(string(raw)), "into team_members") {
			inserts = append(inserts, filepath.ToSlash(path))
		}
		return nil
	}))
	assert.Equal(t, []string{"../store/teams.go"}, inserts, "a new path that inserts team_members rows must start them at own (and be added here after review)")
}
