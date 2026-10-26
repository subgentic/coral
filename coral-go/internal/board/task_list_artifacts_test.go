package board

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8579 (Goal #61): a task list item says how many distinct artifacts its results hold, for the Tasks tab's file count.
func TestTaskListItemCountsItsDistinctArtifacts(t *testing.T) {
	e := newVerEnv(t)
	done := func(name string, arts []TaskArtifact) int64 {
		task, err := e.s.CreateTask(e.ctx, "team", name, "", "medium", "lead", "worker")
		require.NoError(t, err)
		_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
		require.NoError(t, err)
		_, err = e.s.CompleteTaskWithArtifacts(e.ctx, "team", task.ID, "worker", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	none := done("no artifacts", nil)
	inline := done("two inline", []TaskArtifact{{Name: "a.md", Content: "# a"}, {Name: "b.md", Content: "# b"}})
	const obj = "coral://artifacts/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	linked := done("a link twice", []TaskArtifact{{Name: "x", URI: obj}, {Name: "y", URI: obj}, {Name: "z", URI: "https://example.test/report"}})
	inReview := e.inReview("review rows", []TaskArtifact{patchRow("fix", "d1"), {Name: "notes", Content: "x"}}, "rev1")

	page, err := e.s.ListTaskPage(e.ctx, "team", TaskListQuery{Status: TaskListAll, Limit: 50})
	require.NoError(t, err)
	counts := map[int64]int{}
	for _, it := range page.Tasks {
		counts[it.ID] = it.ArtifactCount
		if it.ID == none {
			raw, err := json.Marshal(it)
			require.NoError(t, err)
			assert.NotContains(t, string(raw), "artifact_count", "a task with none sends no key")
		}
	}
	assert.Equal(t, 0, counts[none])
	assert.Equal(t, 2, counts[inline])
	assert.Equal(t, 2, counts[linked], "the object linked twice counts once, a second link is another artifact")
	assert.Equal(t, 2, counts[inReview], "the review's rows count")
	for _, it := range page.Tasks {
		if it.ID == inline {
			raw, err := json.Marshal(it)
			require.NoError(t, err)
			assert.Contains(t, string(raw), `"artifact_count":2`)
		}
	}
}

func TestGoalTaskPageCountsArtifactsToo(t *testing.T) {
	e := newVerEnv(t)
	g, err := e.s.CreateGoal(e.ctx, "team", GoalInput{Title: "A goal", CreatedBy: "lead"})
	require.NoError(t, err)
	task, err := e.s.CreateTaskWithOpts(e.ctx, "team", "goal task", "", "medium", "lead", &CreateTaskOpts{GoalID: &g.ID}, "worker")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
	require.NoError(t, err)
	_, err = e.s.CompleteTaskWithArtifacts(e.ctx, "team", task.ID, "worker", nil, "success", []TaskArtifact{{Name: "a", Content: "1"}, {Name: "b", Content: "2"}, {Name: "c", Content: "3"}})
	require.NoError(t, err)
	page, err := e.s.GoalTaskPage(e.ctx, "team", g.ID, "", "", TaskListMaxLimit)
	require.NoError(t, err)
	require.Len(t, page.Tasks, 1)
	assert.Equal(t, 3, page.Tasks[0].ArtifactCount)
}

// The goal of a task (and its title) for the rows of the team's artifacts.
func TestTaskGoalsNamesTheGoalOfTheTasksThatHaveOne(t *testing.T) {
	e := newVerEnv(t)
	g, err := e.s.CreateGoal(e.ctx, "team", GoalInput{Title: "Ship it", CreatedBy: "lead"})
	require.NoError(t, err)
	with, err := e.s.CreateTaskWithOpts(e.ctx, "team", "with", "", "medium", "lead", &CreateTaskOpts{GoalID: &g.ID}, "worker")
	require.NoError(t, err)
	without, err := e.s.CreateTask(e.ctx, "team", "without", "", "medium", "lead", "worker")
	require.NoError(t, err)
	got, err := e.s.TaskGoals(e.ctx, "team", []int64{with.ID, without.ID, 999999})
	require.NoError(t, err)
	assert.Equal(t, map[int64]TaskGoalRef{with.ID: {ID: g.ID, Title: "Ship it"}}, got)
	other, err := e.s.TaskGoals(e.ctx, "other-team", []int64{with.ID})
	require.NoError(t, err)
	assert.Empty(t, other, "another board's task id is not answered")
}

// #8591: the same count on the rows of the task query (the Inbox and the dock read GET /api/board/tasks): in a field list, and on the whole rows.
func TestTaskQueryRowsCarryTheArtifactCount(t *testing.T) {
	e := newVerEnv(t)
	done := func(name string, arts []TaskArtifact) int64 {
		task, err := e.s.CreateTask(e.ctx, "team", name, "", "medium", "lead", "worker")
		require.NoError(t, err)
		_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
		require.NoError(t, err)
		_, err = e.s.CompleteTaskWithArtifacts(e.ctx, "team", task.ID, "worker", nil, "success", arts)
		require.NoError(t, err)
		return task.ID
	}
	none := done("no files", nil)
	three := done("three files", []TaskArtifact{{Name: "a", Content: "1"}, {Name: "b", Content: "2"}, {Name: "c", Content: "3"}})

	query := func(fields ...string) map[int64]map[string]any {
		res, err := e.s.QueryTasks(e.ctx, &TaskQuery{Boards: []string{"team"}, Fields: fields, Limit: 50})
		require.NoError(t, err)
		out := map[int64]map[string]any{}
		for _, row := range res.Tasks {
			out[row["id"].(int64)] = row
		}
		return out
	}
	rows := query("id", "artifact_count")
	assert.EqualValues(t, 3, rows[three]["artifact_count"])
	assert.NotContains(t, rows[none], "artifact_count", "none: no key")
	assert.NotContains(t, rows[three], "verification", "a field that was not asked for is not sent")

	both := query("id", "verification", "artifact_count")
	assert.EqualValues(t, 3, both[three]["artifact_count"])
	assert.Contains(t, both[three], "verification", "the verification field still comes with it")
	assert.NotContains(t, query("id", "verification")[three], "artifact_count", "only when asked for")
	assert.NotContains(t, query("id", "title")[three], "artifact_count")

	text, err := e.s.QueryTasks(e.ctx, &TaskQuery{Boards: []string{"team"}, Text: "files", Fields: []string{"id", "artifact_count"}, Limit: 50})
	require.NoError(t, err)
	require.NotEmpty(t, text.Tasks)
	for _, row := range text.Tasks {
		if row["id"].(int64) == three {
			assert.EqualValues(t, 3, row["artifact_count"], "a search answers it too")
		}
	}

	whole, _, err := e.s.QueryTaskRows(e.ctx, &TaskQuery{Boards: []string{"team"}, Limit: 50})
	require.NoError(t, err)
	var seen int
	for _, tk := range whole {
		switch tk.ID {
		case three:
			seen++
			assert.Equal(t, 3, tk.ArtifactCount)
			raw, err := json.Marshal(tk)
			require.NoError(t, err)
			assert.Contains(t, string(raw), `"artifact_count":3`)
		case none:
			seen++
			assert.Zero(t, tk.ArtifactCount)
		}
	}
	assert.Equal(t, 2, seen)

	_, err = ParseTaskQuery(TaskQueryParams{Fields: []string{"artifact_count", "id"}})
	assert.NoError(t, err, "a field a caller may name")
}
