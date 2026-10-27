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

// #9471: TasksUnderReview as it was before (one OR that left the status index half used) against the rewrite, on random boards. The old SQL is spelled out here and run on the same
// database: the new code is not compared with itself.
const oldTasksUnderReviewSQL = `SELECT t.id, COALESCE(t.assigned_to, '') AS assigned_to FROM board_tasks t
		 WHERE t.board_id = ? AND (t.status = 'review_pending' OR (t.status = 'in_progress' AND EXISTS (
		   SELECT 1 FROM task_workflows w WHERE w.task_id = t.id AND json_extract(w.data, '$.completion_review') IS NOT NULL)))`

func oldTasksUnderReview(t *testing.T, s *Store, project string) map[int64]string {
	t.Helper()
	var rows []struct {
		ID         int64  `db:"id"`
		AssignedTo string `db:"assigned_to"`
	}
	require.NoError(t, s.reader().SelectContext(context.Background(), &rows, oldTasksUnderReviewSQL, project))
	out := map[int64]string{}
	for _, r := range rows {
		out[r.ID] = r.AssignedTo
	}
	return out
}

func TestTasksUnderReviewAgreesWithTheOldQueryOnRandomBoards(t *testing.T) {
	statuses := []string{"pending", "in_progress", "review_pending", "completed", "blocked", "draft", "skipped"}
	workflows := []string{"", `{}`, `{"completion_review": {"candidate": "x"}}`, `{"completion_review": null}`, `{"other": {"completion_review": 1}}`, `{"completion_review": 0}`, `{"completion_review": ""}`, `not json at all`}
	ctx := context.Background()
	nonEmpty, withReview, withPendingReview := 0, 0, 0
	for seed := int64(1); seed <= 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		s := testStore(t)
		boards := []string{"alpha", "beta", "gamma"}
		for _, b := range boards {
			for i, n := 0, rng.Intn(70); i < n; i++ {
				tk, err := s.CreateTask(ctx, b, fmt.Sprintf("task %d", i), "", "medium", "lead")
				require.NoError(t, err)
				st := statuses[rng.Intn(len(statuses))]
				var assignee any
				if rng.Intn(3) > 0 {
					assignee = fmt.Sprintf("agent-%d", rng.Intn(6))
				}
				_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ?, assigned_to = ? WHERE id = ?`, st, assignee, tk.ID)
				require.NoError(t, err)
				if w := workflows[rng.Intn(len(workflows))]; w != "" {
					// a row that is not valid JSON would make json_extract fail in both queries: keep it out of the data and let the NULL case stand for "no completion_review"
					if strings.HasPrefix(w, "not json") {
						continue
					}
					_, err = s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_workflows (task_id, data) VALUES (?, ?)`, tk.ID, w)
					require.NoError(t, err)
				}
			}
		}
		for _, b := range append(boards, "no-such-board") {
			want := oldTasksUnderReview(t, s, b)
			got, err := s.TasksUnderReview(ctx, b)
			require.NoError(t, err)
			require.Equal(t, want, got, "seed %d, board %s", seed, b)
			if len(want) > 0 {
				nonEmpty++
			}
		}
		var n, np int
		require.NoError(t, s.db.GetContext(ctx, &n, `SELECT COUNT(*) FROM board_tasks WHERE status = 'in_progress' AND id IN (SELECT task_id FROM task_workflows WHERE json_extract(data, '$.completion_review') IS NOT NULL)`))
		require.NoError(t, s.db.GetContext(ctx, &np, `SELECT COUNT(*) FROM board_tasks WHERE status = 'review_pending'`))
		withReview += n
		withPendingReview += np
	}
	assert.Greater(t, nonEmpty, 100, "the boards are not all empty answers")
	assert.Greater(t, withReview, 50, "in_progress tasks with a completion review were compared")
	assert.Greater(t, withPendingReview, 50, "review_pending tasks were compared")
}

// The point of the rewrite: the query looks at the board's review_pending and in_progress tasks through the (board_id, status) index, not at every task of the board.
func TestTasksUnderReviewUsesBothColumnsOfTheStatusIndex(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	explain := func(q string) string {
		rows, err := s.reader().QueryxContext(ctx, "EXPLAIN QUERY PLAN "+q, "alpha")
		require.NoError(t, err)
		defer rows.Close()
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			require.NoError(t, rows.Scan(&id, &parent, &unused, &detail))
			plan = append(plan, detail)
		}
		return strings.Join(plan, "\n")
	}
	newPlan := explain(tasksUnderReviewSQL)
	assert.Regexp(t, `idx_board_tasks_board_status \(board_id=\? AND status=\?\)`, newPlan, "the status is part of the index search")
	assert.NotRegexp(t, `idx_board_tasks_board_status \(board_id=\?\)`, newPlan)
}
