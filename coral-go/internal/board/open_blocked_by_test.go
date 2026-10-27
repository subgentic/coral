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

// #9475: ListOpenTaskStates reads the dependencies of the open tasks with one join on the board and the statuses; loadBlockedBy read them with an IN list of every open task's id.
// The old function is copied below as it was (with its IN list, its own row loop and the rules batch of every id) and run over the same database: the new code is not compared with itself.

func (s *Store) oldLoadBlockedByForTest(ctx context.Context, tasks []Task) {
	if len(tasks) == 0 {
		return
	}
	ids := make([]int64, len(tasks))
	idMap := make(map[int64]*Task, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID
		idMap[tasks[i].ID] = &tasks[i]
	}

	// Build IN clause
	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	query := fmt.Sprintf(
		`SELECT td.task_id, td.blocked_by_task_id, td.blocked_by_board_id, bt.title, bt.status
		 FROM task_dependencies td
		 LEFT JOIN board_tasks bt ON bt.id = td.blocked_by_task_id
		 WHERE td.task_id IN (%s)`, strings.Join(placeholders, ","))

	var rows []struct {
		TaskID           int64   `db:"task_id"`
		BlockedByTaskID  int64   `db:"blocked_by_task_id"`
		BlockedByBoardID string  `db:"blocked_by_board_id"`
		Title            *string `db:"title"`
		Status           *string `db:"status"`
	}
	if err := s.reader().SelectContext(ctx, &rows, query, args...); err != nil {
		return
	}
	if len(rows) == 0 {
		return
	}
	// Like loadDependencyRule per dependency, but batched; on error the
	// dependencies are listed without rule evaluation, as before.
	rules, rulesErr := s.loadDependencyRules(ctx, ids)
	for _, r := range rows {
		t := idMap[r.TaskID]
		if t == nil {
			continue
		}
		dep := TaskDep{TaskID: r.BlockedByTaskID, BoardID: r.BlockedByBoardID}
		if rulesErr == nil {
			applyDependencyRule(&dep, rules[dependencyRuleKey{t.ID, dep.TaskID}])
		}
		if r.Title != nil {
			dep.Title = *r.Title
		}
		if r.Status != nil {
			dep.Status = *r.Status
		}
		t.BlockedBy = append(t.BlockedBy, dep)
	}
}

func TestOpenTaskStatesDependenciesAgreeWithTheOldLoadBlockedByOnRandomBoards(t *testing.T) {
	statuses := []string{"pending", "in_progress", "blocked", "draft", "completed", "skipped", "review_pending"}
	conds := []string{"success", "any", "artifacts", ""}
	ctx := context.Background()
	withDeps, multi, crossBoard, ruled, missing := 0, 0, 0, 0, 0
	for seed := int64(1); seed <= 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		s := testStore(t)
		boards := []string{"alpha", "beta"}
		var ids []int64
		boardOf := map[int64]string{}
		for _, b := range boards {
			for i, n := 0, 3+rng.Intn(40); i < n; i++ {
				tk, err := s.CreateTask(ctx, b, fmt.Sprintf("task %d", i), "", []string{"critical", "high", "medium", "low"}[rng.Intn(4)], "lead")
				require.NoError(t, err)
				_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = ? WHERE id = ?`, statuses[rng.Intn(len(statuses))], tk.ID)
				require.NoError(t, err)
				ids = append(ids, tk.ID)
				boardOf[tk.ID] = b
			}
		}
		for _, id := range ids {
			for k, n := 0, rng.Intn(4); k < n; k++ {
				up := ids[rng.Intn(len(ids))]
				if up == id {
					continue
				}
				upBoard := boardOf[up]
				if rng.Intn(12) == 0 {
					up = 900000 + int64(rng.Intn(50)) // an upstream that is no longer there: its title and status are NULL
					upBoard = "gone"
					missing++
				}
				if _, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO task_dependencies (task_id, blocked_by_task_id, blocked_by_board_id) VALUES (?, ?, ?)`, id, up, upBoard); err != nil {
					t.Fatal(err)
				}
				if c := conds[rng.Intn(len(conds))]; c != "" && rng.Intn(2) == 0 {
					_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO task_dependency_rules (task_id, upstream_id, condition, required_artifacts) VALUES (?, ?, ?, ?)`, id, up, c, `["report.md"]`)
					require.NoError(t, err)
					ruled++
				}
			}
		}
		for _, b := range append(boards, "no-such-board") {
			got, err := s.ListOpenTaskStates(ctx, b)
			require.NoError(t, err)
			old := make([]Task, len(got))
			copy(old, got)
			for i := range old {
				old[i].BlockedBy = nil
			}
			s.oldLoadBlockedByForTest(ctx, old)
			for i := range got {
				require.Equal(t, old[i].BlockedBy, got[i].BlockedBy, "seed %d, board %s, task %d: the same dependencies in the same order", seed, b, got[i].ID)
				if n := len(got[i].BlockedBy); n > 0 {
					withDeps++
					if n > 1 {
						multi++
					}
					for _, d := range got[i].BlockedBy {
						if d.BoardID != b {
							crossBoard++
						}
					}
				}
			}
		}
	}
	assert.Greater(t, withDeps, 300, "tasks with dependencies were compared")
	assert.Greater(t, multi, 50, "tasks with more than one")
	assert.Greater(t, crossBoard, 50, "dependencies on another board's tasks")
	assert.Greater(t, ruled, 100, "dependencies with a rule")
	assert.Greater(t, missing, 20, "dependencies whose upstream is gone")
}

// The join walks the board's open tasks through the (board_id, status) index and probes the dependency table by its primary key: no IN list.
func TestOpenBlockedByReadsThroughTheStatusIndexNotAnIDList(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rows, err := s.reader().QueryxContext(ctx, "EXPLAIN QUERY PLAN "+openBlockedBySQL, "alpha")
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
	assert.Regexp(t, `SEARCH t USING (COVERING )?INDEX idx_board_tasks_board_status \(board_id=\? AND status=\?\)`, joined)
	assert.Contains(t, joined, "task_dependencies")
	assert.NotContains(t, joined, "IN (")
}
