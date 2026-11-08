package background

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #14395: the health oracle's board dump compared a wait's resolved_at to the second, and under -race (13 seeds) the two sides' runs resolved the same wait seconds apart: 'the databases after the run'
// differed on 22:44:36Z against 22:44:39Z. The dump says whether each clock stamp of a wait is SET, never which second; a wait resolved against one that is not still differs.
func TestTheOracleDumpIgnoresWhichSecondAWaitResolvedButNotWhetherItDid(t *testing.T) {
	mk := func(resolved any, expires string) []string { // expires_at is NOT NULL in the real table: only resolved_at can be set or not
		path := filepath.Join(t.TempDir(), "x.db")
		db, err := sql.Open("sqlite", path)
		require.NoError(t, err)
		_, err = db.Exec(`CREATE TABLE board_waits (id INTEGER, status TEXT, resolved_at TEXT, expires_at TEXT NOT NULL, timeout_notified_at TEXT, question_kept_at TEXT)`)
		require.NoError(t, err)
		_, err = db.Exec(`INSERT INTO board_waits VALUES (1, 'expired', ?, ?, NULL, NULL)`, resolved, expires)
		require.NoError(t, err)
		require.NoError(t, db.Close())
		return dumpHealthBoard(t, path)
	}
	assert.Equal(t, mk("2026-11-07T22:44:36Z", "2026-11-07T22:44:36Z"), mk("2026-11-07T22:44:39Z", "2026-11-07T22:44:36Z"), "three seconds apart is the same wait")
	assert.NotEqual(t, mk("2026-11-07T22:44:36Z", "2026-11-07T22:44:36Z"), mk(nil, "2026-11-07T22:44:36Z"), "resolved against not resolved is a difference")
}
