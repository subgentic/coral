package board

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14255 (QA's question on #14091; the Orchestrator's decision from the Operator's words "a new team with no stored setting"): the health check is ON by default for a NEW team only. Every board that exists
// before the upgrade and has no stored health setting gets "off" stored once, so no existing team starts sending health checks and spending tokens when Coral is upgraded; a board that stored on or off keeps
// what it stored; a board made after the migration has the default (on); and the migration runs once.
func TestUpgradeStoresOffForTheTeamsThatNeverSetTheHealthCheckAndKeepsTheRest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	ctx := context.Background()
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)

	// The database as the previous release left it: teams that never set the check (one with members, one with only messages), one that turned it on, one that turned it off. The old migration's marker is
	// there (it ran in an earlier release); the new one's is not.
	_, err = s.Subscribe(ctx, "quiet-team", "Lead", "Orchestrator", "claude-q", nil, "all")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "messages-only", "Lead", "hello", nil)
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "turned-on", "Lead", "Orchestrator", "claude-on", nil, "all")
	require.NoError(t, err)
	require.NoError(t, s.SetHealthOn(ctx, "turned-on", true))
	_, err = s.Subscribe(ctx, "turned-off", "Lead", "Orchestrator", "claude-off", nil, "all")
	require.NoError(t, err)
	require.NoError(t, s.SetHealthOn(ctx, "turned-off", false))
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project = '~store' AND key = ?`, healthDefaultOnMarker)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project IN ('quiet-team', 'messages-only') AND key = 'health'`)
	require.NoError(t, err)
	require.False(t, s.HealthSettingStored(ctx, "quiet-team"), "nothing is stored for a team that never set it")
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "") // the first start of the new release
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.False(t, s.GetHealthSettings(ctx, "quiet-team").On, "an existing team that never set it stays off: nothing starts costing tokens on upgrade")
	assert.True(t, s.HealthSettingStored(ctx, "quiet-team"), "the off is stored, not the default")
	assert.False(t, s.GetHealthSettings(ctx, "messages-only").On, "so does one with only messages")
	assert.True(t, s.GetHealthSettings(ctx, "turned-on").On, "a team that turned it on stays on")
	assert.False(t, s.GetHealthSettings(ctx, "turned-off").On, "a team that turned it off stays off")

	// a team made after the migration has the new default
	_, err = s.Subscribe(ctx, "made-after", "Lead", "Orchestrator", "claude-after", nil, "all")
	require.NoError(t, err)
	assert.True(t, s.GetHealthSettings(ctx, "made-after").On, "a new team is on")
	assert.False(t, s.HealthSettingStored(ctx, "made-after"), "by the default, not by a stored row")

	// a later start does not run it again: the new team keeps the default, and a team the Operator turned on is not turned off
	require.NoError(t, s.SetHealthOn(ctx, "quiet-team", true))
	require.NoError(t, s.Close())
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.True(t, s.GetHealthSettings(ctx, "made-after").On, "the migration ran once: a team made after it is still on")
	assert.False(t, s.HealthSettingStored(ctx, "made-after"))
	assert.True(t, s.GetHealthSettings(ctx, "quiet-team").On, "and a team the Operator turned on afterwards stays on")
}

// A fresh install has no boards: nothing is stored, and the first team is on.
func TestAFreshInstallStoresNothingAndTheFirstTeamIsOn(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	assert.Empty(t, healthOn(t, s, ctx), "no board, nothing stored")
	_, err := s.Subscribe(ctx, "first", "Lead", "Orchestrator", "claude-f", nil, "all")
	require.NoError(t, err)
	assert.True(t, s.GetHealthSettings(ctx, "first").On)
}

// The two promises QA's mutants left unpinned (#14255): the migration never touches a board that STORED a setting, even one with a member (so a board it selects is also one it could overwrite), and it does
// turn off a board that has only messages. The stored setting is more than the on/off: the operator's numbers must survive byte for byte, which "INSERT OR REPLACE" would not.
func TestUpgradeNeverOverwritesAStoredSettingOfATeamWithAMember(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	ctx := context.Background()
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	for name, on := range map[string]bool{"on-with-member": true, "off-with-member": false} {
		_, err = s.Subscribe(ctx, name, "Lead", "Orchestrator", "claude-"+name, nil, "all")
		require.NoError(t, err)
		h := s.GetHealthSettings(ctx, name)
		h.IntervalMin = 35 // the operator's own number
		require.NoError(t, s.setHealthSettings(ctx, name, h))
		require.NoError(t, s.SetHealthOn(ctx, name, on))
	}
	var before map[string]string = map[string]string{}
	for _, name := range []string{"on-with-member", "off-with-member"} {
		var v string
		require.NoError(t, s.db.GetContext(ctx, &v, `SELECT value FROM board_settings WHERE project = ? AND key = 'health'`, name))
		before[name] = v
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project = '~store' AND key = ?`, healthDefaultOnMarker)
	require.NoError(t, err)
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "") // the upgrade
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.True(t, s.GetHealthSettings(ctx, "on-with-member").On, "a team that stored on, and has a member, stays on")
	assert.False(t, s.GetHealthSettings(ctx, "off-with-member").On, "and one that stored off stays off")
	for _, name := range []string{"on-with-member", "off-with-member"} {
		var v string
		require.NoError(t, s.db.GetContext(ctx, &v, `SELECT value FROM board_settings WHERE project = ? AND key = 'health'`, name))
		assert.Equal(t, before[name], v, "%s: the stored setting is byte for byte what it was, not rewritten", name)
		assert.Equal(t, 35, s.GetHealthSettings(ctx, name).IntervalMin, "%s: the operator's number is kept", name)
	}
}

func TestUpgradeTurnsOffATeamThatHasOnlyMessages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "board.db")
	ctx := context.Background()
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "messages-only", "Someone", "hello", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project = '~store' AND key = ?`, healthDefaultOnMarker)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_settings WHERE project = 'messages-only' AND key = 'health'`)
	require.NoError(t, err)
	var subs int
	require.NoError(t, s.db.GetContext(ctx, &subs, `SELECT COUNT(*) FROM board_subscribers WHERE project = 'messages-only'`))
	require.Zero(t, subs, "the team has no member: only the message selects it")
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	assert.False(t, s.GetHealthSettings(ctx, "messages-only").On, "a team with only messages is turned off")
	assert.True(t, s.HealthSettingStored(ctx, "messages-only"), "stored, not the default")
}
