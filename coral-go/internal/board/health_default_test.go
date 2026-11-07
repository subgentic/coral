package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14091, the operator (2026-11-07, "turn health check on for teams by default"; this reverses #4962): a team that has not set the health check has it ON, with the current rules and intervals; a team that stored OFF keeps
// off, and turning it on or off keeps the numbers the operator set.
func TestHealthCheckIsOnByDefault(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	assert.True(t, DefaultHealthSettings().On)
	got := s.GetHealthSettings(ctx, "never-set")
	assert.True(t, got.On, "a board with no stored setting")
	assert.Equal(t, 10, got.IntervalMin, "the current interval")
	assert.Equal(t, 0, got.HeartbeatMin, "and no 'no change' heartbeat: a quiet team hears nothing")
	assert.True(t, got.ClaimNudge.On, "its rules are on with it")
	assert.False(t, got.Landing.On, "the opt-in rules stay opt-in")
	assert.False(t, got.DialogTimeout.On, "Coral acting in an agent's terminal on its own is still the operator's choice")
	assert.False(t, got.AutoRecommend.On)
	assert.Empty(t, healthOn(t, s, ctx), "nothing stored: nothing in the map")

	// a person's choice is never flipped: stored OFF stays off, with the numbers they set
	got.IntervalMin = 30
	require.NoError(t, s.setHealthSettings(ctx, "team", got))
	require.NoError(t, s.SetHealthOn(ctx, "team", false))
	off := s.GetHealthSettings(ctx, "team")
	assert.False(t, off.On, "a team that stored off keeps off")
	assert.Equal(t, 30, off.IntervalMin)
	assert.Equal(t, map[string]bool{"team": false}, healthOn(t, s, ctx))
	require.NoError(t, s.SetHealthOn(ctx, "team", true))
	assert.True(t, s.GetHealthSettings(ctx, "team").On)
	assert.Equal(t, 30, s.GetHealthSettings(ctx, "team").IntervalMin, "turning it on keeps the operator's numbers")
	assert.Equal(t, map[string]bool{"team": true}, healthOn(t, s, ctx))
}

// A team that was running the check when the default became off (it had none stored: on by default) stays on: the first start
// after the change stores "on" for it; a team that had it off keeps that (the migration marker stays as it is, #14091).
func TestHealthDefaultOffKeepsTheTeamsThatHadItOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	ctx := context.Background()
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "had-default", "Lead", "Orchestrator", "claude-a", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "turned-off", "Lead", "Orchestrator", "claude-b", nil, "all")
	require.NoError(t, err)
	require.NoError(t, s.SetHealthOn(ctx, "turned-off", false))
	_, err = s.PostMessage(ctx, "only-messages", "Lead", "hello", nil)
	require.NoError(t, err)
	// The database as an older Coral left it: no marker, and no health setting for a team that never changed it.
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project = '~store'`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project IN ('had-default', 'only-messages') AND key = 'health'`)
	require.NoError(t, err)
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.True(t, s.GetHealthSettings(ctx, "had-default").On, "a team on by the old default stays on")
	assert.True(t, s.GetHealthSettings(ctx, "only-messages").On, "so does one with only messages")
	assert.False(t, s.GetHealthSettings(ctx, "turned-off").On, "a team that turned it off keeps it off")

	_, err = s.Subscribe(ctx, "made-after", "Lead", "Orchestrator", "claude-c", nil, "all")
	require.NoError(t, err)
	assert.True(t, s.GetHealthSettings(ctx, "made-after").On, "a team made after the change has the default, which is on since #14091")

	// A later start does not run the migration again: a stored OFF is never turned on.
	require.NoError(t, s.Close())
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.True(t, s.GetHealthSettings(ctx, "made-after").On)
	assert.True(t, s.GetHealthSettings(ctx, "had-default").On)
	assert.False(t, s.GetHealthSettings(ctx, "turned-off").On, "and a team that turned it off still has it off")
}

func healthOn(t *testing.T, s *Store, ctx context.Context) map[string]bool {
	t.Helper()
	on, err := s.HealthOnByProject(ctx)
	require.NoError(t, err)
	return on
}

// A read that fails is an error, not an empty map (an empty map reads as every team off, #5119).
func TestHealthOnByProjectReportsAFailedRead(t *testing.T) {
	s := testStore(t)
	require.NoError(t, s.SetHealthOn(context.Background(), "team", true))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	on, err := s.HealthOnByProject(ctx)
	assert.Error(t, err)
	assert.Nil(t, on)
}
