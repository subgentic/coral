package board

import (
	"context"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9611 and #9623: the boards the open adopts, and the backfill of messages with no subscriber_id, no longer scan every message and task. The old statements are spelled out and run on the same database.
const oldAdoptBoardsSQL = `
	INSERT OR IGNORE INTO boards (id, label, created_at)
	SELECT key, key, MIN(at) FROM (
		SELECT project AS key, subscribed_at AS at FROM board_subscribers
		UNION ALL SELECT project, created_at FROM board_messages
		UNION ALL SELECT board_id, created_at FROM board_tasks
	) WHERE key <> '' GROUP BY key`

func boardRows(t *testing.T, s *Store) string {
	t.Helper()
	var rows []struct {
		ID        string `db:"id"`
		Label     string `db:"label"`
		CreatedAt string `db:"created_at"`
		CreatedBy string `db:"created_by"`
	}
	require.NoError(t, s.db.SelectContext(context.Background(), &rows, `SELECT id, label, created_at, created_by FROM boards ORDER BY id`))
	return fmt.Sprint(rows)
}

func TestAdoptBoardsMatchesTheFullScan(t *testing.T) {
	ctx := context.Background()
	rng := rand.New(rand.NewSource(9623))
	adopted := 0
	for round := 0; round < 12; round++ {
		s := testStore(t)
		var names []string
		for i := 0; i < 8; i++ {
			names = append(names, fmt.Sprintf("team-%d-%d", round, i))
		}
		for _, n := range names {
			// a board known through subscribers, messages, tasks, any mix of them, or none
			if rng.Intn(2) == 0 {
				_, err := sub(s, ctx, n, "dev", "Dev")
				require.NoError(t, err)
			}
			if rng.Intn(2) == 0 {
				if _, err := sub(s, ctx, n, "poster", "Poster"); err == nil {
					for i := rng.Intn(4); i > 0; i-- {
						_, err = s.PostMessage(ctx, n, "poster", fmt.Sprintf("m%d", i), nil)
						require.NoError(t, err)
					}
				}
			}
			if rng.Intn(2) == 0 { // known through its messages alone
				_, err := s.db.ExecContext(ctx, `DELETE FROM board_subscribers WHERE project = ?`, n)
				require.NoError(t, err)
			}
			for i := rng.Intn(3); i > 0; i-- {
				_, err := s.CreateTask(ctx, n, fmt.Sprintf("t%d", i), "b", "medium", "Orch")
				require.NoError(t, err)
			}
		}
		// distinct creation times, so a board's MIN(created_at) differs from its MAX and from the other kinds' times
		_, err := s.db.ExecContext(ctx, `UPDATE board_tasks SET created_at = printf('2021-01-01T00:%02d:%02dZ', (id / 60) % 60, id % 60)`)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET created_at = printf('2022-01-01T00:%02d:%02dZ', (id / 60) % 60, id % 60)`)
		require.NoError(t, err)
		// the boards table as the old statement leaves it, with some rows pre-existing under another label (a rename survives)
		_, err = s.db.ExecContext(ctx, `DELETE FROM boards`)
		require.NoError(t, err)
		for _, n := range names {
			if rng.Intn(3) == 0 {
				_, err := s.db.ExecContext(ctx, `INSERT INTO boards (id, label, created_at, created_by) VALUES (?, ?, '2020-01-01T00:00:00Z', 'someone')`, n, "renamed "+n)
				require.NoError(t, err)
			}
		}
		var existing int
		require.NoError(t, s.db.GetContext(ctx, &existing, `SELECT COUNT(*) FROM boards`))
		_, err = s.db.ExecContext(ctx, `CREATE TEMP TABLE boards_before AS SELECT * FROM boards`)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, oldAdoptBoardsSQL)
		require.NoError(t, err)
		want := boardRows(t, s)
		_, err = s.db.ExecContext(ctx, `DELETE FROM boards; INSERT INTO boards SELECT * FROM boards_before; DROP TABLE boards_before`)
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, adoptBoardsSQL)
		require.NoError(t, err)
		assert.Equal(t, want, boardRows(t, s), "round %d", round)
		var total int
		require.NoError(t, s.db.GetContext(ctx, &total, `SELECT COUNT(*) FROM boards`))
		adopted += total - existing
		// and again: nothing changes
		_, err = s.db.ExecContext(ctx, adoptBoardsSQL)
		require.NoError(t, err)
		assert.Equal(t, want, boardRows(t, s), "round %d, second run", round)
	}
	assert.Greater(t, adopted, 30, "boards were adopted and compared")
}

// The messages arm does not scan the messages once every board has a row: the plan of the statement that finds the missing ones touches board_message_counts, not an index of every message.
func TestAdoptBoardsDoesNotScanMessages(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	rows, err := s.db.QueryxContext(ctx, `EXPLAIN QUERY PLAN `+adoptBoardsSQL)
	require.NoError(t, err)
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, x int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &x, &detail))
		plan = append(plan, detail)
	}
	all := strings.Join(plan, "\n")
	assert.NotContains(t, all, "SCAN board_messages", all)
	assert.NotContains(t, all, "SCAN board_tasks", all)
}

func TestMessageSubscriberBackfillUsesThePartialIndex(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	_, err := sub(s, ctx, "alpha", "dev", "Dev")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "alpha", "dev", "hello", nil)
	require.NoError(t, err)
	// a message an older binary wrote with no subscriber_id
	_, err = s.db.ExecContext(ctx, `UPDATE board_messages SET subscriber_id = NULL`)
	require.NoError(t, err)
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages WHERE subscriber_id IS NULL`))
	require.Equal(t, 1, n)
	s.backfillBoardSubscriberIDs(ctx)
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_messages WHERE subscriber_id IS NULL`))
	assert.Equal(t, 0, n, "the backfill finds the message through the partial index and sets it")

	var plan []string
	rows, err := s.db.QueryxContext(ctx, `EXPLAIN QUERY PLAN UPDATE board_messages SET subscriber_id = 'x' WHERE subscriber_id IS NULL`)
	require.NoError(t, err)
	defer rows.Close()
	for rows.Next() {
		var id, parent, x int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &x, &detail))
		plan = append(plan, detail)
	}
	// a walk of the partial index (empty once the backfill has run), not of the table
	assert.Equal(t, "SCAN board_messages USING INDEX idx_board_messages_no_subscriber", strings.Join(plan, "\n"))
}
