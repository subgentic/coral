package board

import (
	"context"
	"fmt"
	"math/rand"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9503: ListProjects reads each board's message count from board_message_counts instead of counting board_messages. The old query is spelled out here and run on the same database against the
// new: the new code is not compared with itself.
const oldListProjectsSQL = `SELECT project,
		        COALESCE((SELECT b.created_at FROM boards b WHERE b.id = p.project), '') as created_at,
		        (SELECT COUNT(*) FROM board_subscribers s WHERE s.project = p.project AND s.is_active = 1) as subscriber_count,
		        (SELECT COUNT(*) FROM board_messages m WHERE m.project = p.project) as message_count,
		        (SELECT COUNT(*) FROM board_goals g WHERE g.board_id = p.project AND g.state IN ('proposed', 'active', 'blocked')) as goals_open,
		        COALESCE((SELECT seq FROM board_goal_meta gm WHERE gm.board_id = p.project), 0) as goals_seq
		 FROM (
		     SELECT DISTINCT project FROM board_subscribers WHERE is_active = 1
		     UNION
		     SELECT DISTINCT project FROM board_messages
		 ) p ORDER BY project`

func sameProjects(t *testing.T, s *Store, why string) {
	t.Helper()
	var want []ProjectInfo
	require.NoError(t, s.reader().SelectContext(context.Background(), &want, oldListProjectsSQL))
	got, err := s.ListProjects(context.Background())
	require.NoError(t, err)
	require.Len(t, got, len(want), why)
	for i := range want {
		assert.Equal(t, want[i].Project, got[i].Project, why)
		assert.Equal(t, want[i].CreatedAt, got[i].CreatedAt, why)
		assert.Equal(t, want[i].SubscriberCount, got[i].SubscriberCount, why)
		assert.Equal(t, want[i].MessageCount, got[i].MessageCount, "%s: board %s", why, want[i].Project)
		assert.Equal(t, want[i].GoalsOpen, got[i].GoalsOpen, why)
		assert.Equal(t, want[i].GoalsSeq, got[i].GoalsSeq, why)
	}
}

func TestListProjectsAgreesWithTheOldQueryThroughPostsDeletesMovesAndProjectDeletes(t *testing.T) {
	ctx := context.Background()
	compared, withMessages, emptyAfterDelete := 0, 0, 0
	for seed := int64(1); seed <= 25; seed++ {
		rng := rand.New(rand.NewSource(seed))
		s := testStore(t)
		boards := []string{"alpha", "beta", "gamma", "delta"}
		var ids []int64
		idBoard := map[int64]string{}
		sameProjects(t, s, "empty")
		for step := 0; step < 60; step++ {
			b := boards[rng.Intn(len(boards))]
			switch op := rng.Intn(10); {
			case op < 5: // a post
				sender := fmt.Sprintf("agent-%d", rng.Intn(3))
				_, err := sub(s, ctx, b, sender, "Dev")
				require.NoError(t, err)
				m, err := s.PostMessage(ctx, b, sender, fmt.Sprintf("hello %d", step), nil)
				require.NoError(t, err)
				ids = append(ids, m.ID)
				idBoard[m.ID] = b
			case op == 5: // a subscriber with no message
				_, err := sub(s, ctx, b, fmt.Sprintf("quiet-%d", rng.Intn(3)), "QA")
				require.NoError(t, err)
			case op == 6 && len(ids) > 0: // a message deleted
				id := ids[rng.Intn(len(ids))]
				_, err := s.DeleteMessage(ctx, idBoard[id], id)
				require.NoError(t, err)
			case op == 7 && len(ids) > 0: // a message moved to another board (the update trigger)
				id := ids[rng.Intn(len(ids))]
				to := boards[rng.Intn(len(boards))]
				_, err := s.db.ExecContext(ctx, `UPDATE board_messages SET project = ? WHERE id = ?`, to, id)
				require.NoError(t, err)
				idBoard[id] = to
			case op == 8: // a message written as an older binary would (no API, a bare INSERT: the trigger sees it)
				res, err := s.db.ExecContext(ctx, `INSERT INTO board_messages (project, session_id, content, created_at) VALUES (?, 'x', 'raw', '2026-10-01T00:00:00Z')`, b)
				require.NoError(t, err)
				id, _ := res.LastInsertId()
				ids = append(ids, id)
				idBoard[id] = b
			case op == 9 && rng.Intn(3) == 0: // a board deleted whole
				require.NoError(t, s.DeleteProject(ctx, b))
				for id, ib := range idBoard {
					if ib == b {
						delete(idBoard, id)
					}
				}
				emptyAfterDelete++
			}
			if step%5 == 0 {
				sameProjects(t, s, fmt.Sprintf("seed %d step %d", seed, step))
				compared++
			}
		}
		sameProjects(t, s, fmt.Sprintf("seed %d end", seed))
		got, err := s.ListProjects(ctx)
		require.NoError(t, err)
		for _, p := range got {
			if p.MessageCount > 0 {
				withMessages++
			}
		}
	}
	assert.Greater(t, compared, 250)
	assert.Greater(t, withMessages, 40, "boards with messages were compared")
	assert.Greater(t, emptyAfterDelete, 20, "whole-board deletes were compared")
}

// The counts are checked at every open: a table that drifted (a writer with no triggers, a manual edit) is repaired, and a table that does not exist is built from the messages.
func TestMessageCountsAreRecountedAndRepairedAtOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	for i := 0; i < 7; i++ {
		_, err := sub(s, ctx, "alpha", "dev", "Dev")
		require.NoError(t, err)
		_, err = s.PostMessage(ctx, "alpha", "dev", fmt.Sprintf("m%d", i), nil)
		require.NoError(t, err)
	}
	_, err = sub(s, ctx, "beta", "dev", "Dev")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, "beta", "dev", "one", nil)
	require.NoError(t, err)
	// drift: a count that is wrong, a count for a board with no messages, a board whose count is missing
	for _, q := range []string{`UPDATE board_message_counts SET n = 99 WHERE project = 'alpha'`, `INSERT INTO board_message_counts VALUES ('ghost', 4)`, `DELETE FROM board_message_counts WHERE project = 'beta'`} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err, q)
	}
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	sameProjects(t, s, "after the repair")
	var n int
	require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_message_counts WHERE project = 'ghost'`))
	assert.Zero(t, n, "a count for a board with no messages is gone")
	got, err := s.ListProjects(ctx)
	require.NoError(t, err)
	counts := map[string]int{}
	for _, p := range got {
		counts[p.Project] = p.MessageCount
	}
	assert.Equal(t, map[string]int{"alpha": 7, "beta": 1}, counts)

	// a database that has no table yet (an older Coral's) is built from its messages
	_, err = s.db.ExecContext(ctx, `DROP TRIGGER board_message_counts_ai`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DROP TRIGGER board_message_counts_ad`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DROP TRIGGER board_message_counts_au`)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `DROP TABLE board_message_counts`)
	require.NoError(t, err)
	require.NoError(t, s.Close())
	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	sameProjects(t, s, "built at open")
}

// ListProjects reads the counts table and does not scan the messages.
func TestListProjectsDoesNotScanTheMessages(t *testing.T) {
	s := testStore(t)
	rows, err := s.reader().QueryxContext(context.Background(), "EXPLAIN QUERY PLAN "+listProjectsSQL)
	require.NoError(t, err)
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var id, parent, unused int
		var detail string
		require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
		plan = append(plan, detail)
	}
	joined := strings.Join(plan, "\n")
	assert.Contains(t, joined, "board_message_counts")
	assert.NotRegexp(t, `(SCAN|SEARCH) (m|board_messages)\b`, joined)
}
