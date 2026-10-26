package board

import (
	"fmt"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Schema-only goldens cannot see a backfill that ran too early and only logged
// missing-column warnings. Pin the first open's rows before a second open can
// accidentally repair them (#8458, #8390).
func TestBoardUpgradeFromBeforeSubscriberIDs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messageboard.db")
	loadDump(t, path, filepath.Join("testdata", "migration", "pre-subscriber-ids", "messageboard.sql"))
	for table, columns := range map[string][]string{
		"board_subscribers": {"subscriber_id", "session_name"},
		"board_messages":    {"subscriber_id"},
		"board_groups":      {"subscriber_id"},
	} {
		for _, column := range columns {
			require.Equal(t, "0", scalar(t, path, "SELECT count(*) FROM pragma_table_info(?) WHERE name=?", table, column), "%s.%s must not pre-exist", table, column)
		}
	}
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	require.NoError(t, s.Close())

	// The old terminal identity survives in session_name; the subscriber key
	// and compatibility session_id become the role, without losing cursors.
	for id, want := range []string{
		"alpha|Builder|old-shell-1|Builder|Builder|7",
		"alpha|Reviewer|old-shell-2|Reviewer|Reviewer|9",
		"beta|Other Role|old-shell-1|Other Role|Other Role|3",
	} {
		require.Equal(t, want, scalar(t, path, `SELECT project || '|' || session_id || '|' || session_name || '|' || subscriber_id || '|' || job_title || '|' || last_read_id FROM board_subscribers WHERE id=?`, id+1), "subscriber %d on first open", id+1)
	}
	// Backfills are scoped to the board even when two boards share a terminal
	// name. A departed sender falls back to its original identity.
	for table, wants := range map[string][]string{
		"board_messages": {"Builder", "departed-shell", "Other Role"},
		"board_groups":   {"Reviewer", "Other Role", "departed-shell"},
	} {
		for id, want := range wants {
			require.Equal(t, want, scalar(t, path, fmt.Sprintf("SELECT subscriber_id FROM %s WHERE id=?", table), id+1), "%s row %d on first open", table, id+1)
		}
	}
	require.Equal(t, "3", scalar(t, path, "SELECT count(*) FROM board_subscribers"))
	require.Equal(t, "3", scalar(t, path, "SELECT count(*) FROM board_messages"))
	require.Equal(t, "3", scalar(t, path, "SELECT count(*) FROM board_groups"))
	require.Equal(t, "retained builder post", scalar(t, path, "SELECT content FROM board_messages WHERE id=1"))

	first := readShape(t, path)
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	require.NoError(t, s.Close())
	require.Equal(t, first, readShape(t, path), "second open must preserve every migrated row and schema object")
}
