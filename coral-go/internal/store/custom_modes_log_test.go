package store_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #15950 (Security): every save of the custom permission modes leaves one audit row (when, how many modes, how many turn the prompts off), written in the same
// transaction as the set, so a save that fails leaves neither.
func TestEverySaveOfTheCustomModesLeavesOneAuditRow(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/s.db")
	require.NoError(t, err)
	ss := store.NewSessionStore(db)
	ctx := context.Background()
	rows := func() (n, modes, bypass int) {
		require.NoError(t, db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(modes), 0), COALESCE(SUM(bypass), 0) FROM custom_modes_log`).Scan(&n, &modes, &bypass))
		return
	}
	require.NoError(t, ss.ReplaceCustomModes(ctx, []store.CustomMode{
		{ID: "aaaaaaaaaaaaaaaa", AgentType: "claude", Name: "Plan only", Flags: []string{"--permission-mode", "plan"}},
		{ID: "bbbbbbbbbbbbbbbb", AgentType: "codex", Name: "Wide open", Flags: []string{"-a", "never"}},
	}, 1))
	n, modes, bypass := rows()
	require.Equal(t, []int{1, 2, 1}, []int{n, modes, bypass}, "one row: two modes, one that turns the prompts off")
	require.NoError(t, ss.ReplaceCustomModes(ctx, nil, 0))
	n, modes, bypass = rows()
	require.Equal(t, []int{2, 2, 1}, []int{n, modes, bypass}, "clearing the set is a save too, and the earlier row stays")
	// a save that fails (a duplicate id) leaves no row and keeps the set as it was
	dup := []store.CustomMode{{ID: "cccccccccccccccc", AgentType: "claude", Name: "A", Flags: []string{}}, {ID: "cccccccccccccccc", AgentType: "claude", Name: "B", Flags: []string{}}}
	require.Error(t, ss.ReplaceCustomModes(ctx, dup, 0))
	n, _, _ = rows()
	require.Equal(t, 2, n, "a failed save writes no audit row")
}
