package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// A database made by a dev or beta build already has keep_full_access, without the source column (#14193). Opening it must add the column (columnMigrations), keep the choices that are there as local
// ones (they were made by the Operator at this computer, and the hub's switch must not end them), and every query of the new shape must work: without the migration every restart and wake failed.
func TestADatabaseWithTheOldKeepFullAccessTableIsMigrated(t *testing.T) {
	ctx := context.Background()
	p := filepath.Join(t.TempDir(), "old.db")
	db, err := OpenWithKey(ctx, p, "")
	require.NoError(t, err)
	// the table as the earlier build made it: no source column, one choice in it
	_, err = db.ExecContext(ctx, `DROP TABLE keep_full_access`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `CREATE TABLE keep_full_access (session_id TEXT PRIMARY KEY, set_at INTEGER NOT NULL)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO keep_full_access (session_id, set_at) VALUES ('old-choice', 1)`)
	require.NoError(t, err)
	require.NoError(t, db.Close())

	db, err = OpenWithKey(ctx, p, "") // the next start of Coral
	require.NoError(t, err)
	defer db.Close()
	s := NewSessionStore(db)

	var n int
	require.NoError(t, db.GetContext(ctx, &n, `SELECT COUNT(*) FROM pragma_table_info('keep_full_access') WHERE name = 'source'`))
	require.Equal(t, 1, n, "the column was added")

	on, err := s.KeepFullAccess(ctx, "old-choice")
	require.NoError(t, err)
	require.True(t, on, "the earlier choice is still there")
	changed, err := s.SetKeepFullAccessFrom(ctx, "new-hub", true, KeepSourceHub)
	require.NoError(t, err, "the new-shape write works on the migrated table")
	require.True(t, changed)
	cleared, err := s.ClearHubKeepFullAccess(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, cleared, "only the hub-made one; the earlier choice counts as local")
	on, _ = s.KeepFullAccess(ctx, "old-choice")
	require.True(t, on, "the Operator's earlier choice outlives the hub's switch")
	require.NoError(t, s.RegisterLiveSession(ctx, &LiveSession{SessionID: "old-choice", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp"}))
	require.NoError(t, s.ReplaceLiveSession(ctx, "old-choice", &LiveSession{SessionID: "replacement", AgentType: "codex", AgentName: "a", WorkingDir: "/tmp"}))
	on, err = s.KeepFullAccess(ctx, "replacement")
	require.NoError(t, err)
	require.True(t, on, "a restart (ReplaceLiveSession) carries the earlier choice")
}
