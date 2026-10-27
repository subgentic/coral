package board

import (
	"context"
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9560: the follow-ups of a task are read from task_workflows.lst_parent, not by a json_extract over every workflow. The old queries are spelled out and run on the same database.
const oldFollowUpsSQL = `SELECT t.id, t.title, t.status, t.assigned_to
		FROM task_workflows w JOIN board_tasks t ON t.id = w.task_id
		WHERE t.board_id = ? AND json_extract(w.data, '$.parent_task_id') = ? ORDER BY t.id`

const oldGoalFollowUpsOpenSQL = `SELECT COUNT(*) FROM board_tasks t JOIN task_workflows w ON w.task_id = t.id
		WHERE t.board_id = ? AND t.goal_id = ? AND t.status NOT IN ('completed', 'skipped', 'cancelled') AND COALESCE(json_extract(w.data, '$.parent_task_id'), 0) > 0`

func sameFollowUps(t *testing.T, s *Store, boards []string, goals map[string][]int64, ids map[string][]int64, why string) (compared, nonEmpty int) {
	t.Helper()
	ctx := context.Background()
	for _, b := range boards {
		for _, id := range ids[b] {
			var want []FollowUp
			require.NoError(t, s.reader().SelectContext(ctx, &want, oldFollowUpsSQL, b, id))
			got, err := s.FollowUps(ctx, b, id)
			require.NoError(t, err)
			require.Equal(t, len(want), len(got), "%s: board %s task %d", why, b, id)
			for i := range want {
				assert.Equal(t, want[i].ID, got[i].ID, why)
				assert.Equal(t, want[i].Status, got[i].Status, why)
			}
			compared++
			if len(want) > 0 {
				nonEmpty++
			}
		}
		for _, g := range goals[b] {
			var want int
			require.NoError(t, s.reader().GetContext(ctx, &want, oldGoalFollowUpsOpenSQL, b, g))
			got, err := s.goalFollowUpsOpen(ctx, b, g)
			require.NoError(t, err)
			assert.Equal(t, want, got, "%s: goal %d of %s", why, g, b)
		}
	}
	return compared, nonEmpty
}

func TestFollowUpsFromTheColumnMatchTheJSONQuery(t *testing.T) {
	ctx := context.Background()
	s := testStore(t)
	rng := rand.New(rand.NewSource(9560))
	boards := []string{"alpha", "beta", "gamma"}
	goals := map[string][]int64{}
	ids := map[string][]int64{}
	for _, b := range boards {
		for g := 0; g < 2; g++ {
			goals[b] = append(goals[b], newGoal(t, s, b, fmt.Sprintf("Goal %d", g)).ID)
		}
		for i := 0; i < 60; i++ {
			opts := &CreateTaskOpts{GoalID: &goals[b][rng.Intn(2)]}
			if len(ids[b]) > 0 && rng.Intn(3) == 0 {
				opts.Workflow = TaskWorkflow{ParentTaskID: ids[b][rng.Intn(len(ids[b]))]}
			}
			c, err := s.CreateTaskWithOpts(ctx, b, fmt.Sprintf("task %d", i), "", "medium", "Orch", opts, "Dev")
			require.NoError(t, err)
			ids[b] = append(ids[b], c.ID)
			if rng.Intn(4) == 0 {
				_, err = s.db.ExecContext(ctx, "UPDATE board_tasks SET status = ? WHERE id = ?", []string{"completed", "skipped", "in_progress", "blocked"}[rng.Intn(4)], c.ID)
				require.NoError(t, err)
			}
		}
	}
	compared, nonEmpty := sameFollowUps(t, s, boards, goals, ids, "after the writes")
	assert.Equal(t, 180, compared)
	assert.Greater(t, nonEmpty, 20, "tasks with follow-ups were compared")
}

// The column is derived data checked at every open: a row an older Coral wrote without it, a column left on after the document lost its parent, and a wrong value are all repaired.
func TestParentTaskColumnIsRepairedAtOpen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "board.db")
	s, err := NewStoreWithKey(path, "")
	require.NoError(t, err)
	g := newGoal(t, s, "alpha", "G")
	gid := g.ID
	parent, err := s.CreateTaskWithOpts(ctx, "alpha", "parent", "", "medium", "Orch", &CreateTaskOpts{GoalID: &gid}, "Dev")
	require.NoError(t, err)
	other, err := s.CreateTaskWithOpts(ctx, "alpha", "other", "", "medium", "Orch", &CreateTaskOpts{GoalID: &gid}, "Dev")
	require.NoError(t, err)
	var kids []int64
	for i := 0; i < 3; i++ {
		c, err := s.CreateTaskWithOpts(ctx, "alpha", fmt.Sprintf("kid %d", i), "", "medium", "Orch", &CreateTaskOpts{GoalID: &gid, Workflow: TaskWorkflow{ParentTaskID: parent.ID}}, "Dev")
		require.NoError(t, err)
		kids = append(kids, c.ID)
	}
	for _, q := range []string{
		fmt.Sprintf(`UPDATE task_workflows SET lst_parent = 0 WHERE task_id = %d`, kids[0]),              // a column the document does not back
		fmt.Sprintf(`UPDATE task_workflows SET lst_parent = 999 WHERE task_id = %d`, kids[1]),            // a wrong value
		fmt.Sprintf(`UPDATE task_workflows SET lst_parent = %d WHERE task_id = %d`, parent.ID, other.ID), // left on with no parent in the document
	} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err, q)
	}
	require.NoError(t, s.Close())

	s, err = NewStoreWithKey(path, "")
	require.NoError(t, err)
	defer s.Close()
	got, err := s.FollowUps(ctx, "alpha", parent.ID)
	require.NoError(t, err)
	require.Len(t, got, 3)
	for i, id := range kids {
		assert.Equal(t, id, got[i].ID)
	}
	sameFollowUps(t, s, []string{"alpha"}, map[string][]int64{"alpha": {gid}}, map[string][]int64{"alpha": append([]int64{parent.ID, other.ID}, kids...)}, "after the repair")
}
