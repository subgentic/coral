package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A task says who did its work (worked_by): a reviewed task is handed to the orchestrator, so its assignee is not its author (#7665).
func TestWorkedByNamesWhoDidTheWork(t *testing.T) {
	e := newVerEnv(t)
	workedBy := func(id int64) string { return e.task(id).WorkedBy }

	// never reviewed: whoever completed it
	plain, err := e.s.CreateTask(e.ctx, "team", "plain", "", "medium", "lead", "worker")
	require.NoError(t, err)
	assert.Equal(t, "worker", workedBy(plain.ID), "a task nobody has claimed names its assignee")
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", plain.ID)
	require.NoError(t, err)
	_, err = e.s.CompleteTask(e.ctx, "team", plain.ID, "worker", nil)
	require.NoError(t, err)
	assert.Equal(t, "worker", workedBy(plain.ID))

	// reviewed: the author, not the orchestrator it was handed to and who completed it
	id := e.inReview("reviewed", []TaskArtifact{patchRow("fix", "d1")}, "rev1")
	require.NotNil(t, e.task(id).AssignedTo)
	assert.Equal(t, "lead", *e.task(id).AssignedTo, "in review it is the orchestrator's")
	assert.Equal(t, "worker", workedBy(id), "and still the author's work")
	v, err := e.s.ApproveReview(e.ctx, "team", id, "rev1", "ok", 0)
	require.NoError(t, err)
	e.finish(v)
	done := e.task(id)
	require.Equal(t, "completed", done.Status)
	require.NotNil(t, done.CompletedBy)
	assert.Equal(t, "lead", *done.CompletedBy, "the orchestrator completed it")
	assert.Equal(t, "worker", done.WorkedBy, "the author did the work")

	// sent back: the author again
	back, err := e.s.SendBack(e.ctx, "team", id, "lead", "conflicts in a.go")
	require.NoError(t, err)
	assert.Equal(t, "worker", back.WorkedBy)

	// cancelled: nobody finished it, so its assignee
	doomed, err := e.s.CreateTask(e.ctx, "team", "doomed", "", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = e.s.CancelTask(e.ctx, "team", doomed.ID, "lead", nil)
	require.NoError(t, err)
	assert.Equal(t, "worker", workedBy(doomed.ID), "a cancelled task is its assignee's, not the one who cancelled it")

	// nobody has it
	free, err := e.s.CreateTask(e.ctx, "team", "free", "", "medium", "lead", "")
	require.NoError(t, err)
	assert.Equal(t, "", workedBy(free.ID))
}

// The list carries it too, and a task whose workflow row is missing (an old or a deleted one) falls back to its completer or assignee without an error: the read runs on every list.
func TestWorkedByInTheListAndWithoutAWorkflowRow(t *testing.T) {
	e := newVerEnv(t)
	task, err := e.s.CreateTask(e.ctx, "team", "old", "", "medium", "lead", "worker")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
	require.NoError(t, err)
	_, err = e.s.CompleteTask(e.ctx, "team", task.ID, "worker", nil)
	require.NoError(t, err)
	_, err = e.s.db.ExecContext(e.ctx, `DELETE FROM task_workflows WHERE task_id = ?`, task.ID)
	require.NoError(t, err)
	tasks, err := e.s.ListTasks(e.ctx, "team")
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	assert.Equal(t, "worker", tasks[0].WorkedBy, "the completer, with no workflow row to read")
}

// The task list items (the Tasks tab's, the goal's) say it the same way (#7665).
func TestWorkedByOnTheListItems(t *testing.T) {
	e := newVerEnv(t)
	id := e.inReview("reviewed", []TaskArtifact{patchRow("fix", "d1")}, "rev1")
	plain, err := e.s.CreateTask(e.ctx, "team", "plain", "", "medium", "lead", "worker")
	require.NoError(t, err)
	free, err := e.s.CreateTask(e.ctx, "team", "free", "", "medium", "lead", "")
	require.NoError(t, err)
	page, err := e.s.ListTaskPage(e.ctx, "team", TaskListQuery{Status: TaskListAll})
	require.NoError(t, err)
	by := map[int64]string{}
	for _, item := range page.Tasks {
		by[item.ID] = item.WorkedBy
	}
	assert.Equal(t, "worker", by[id], "in review the list names the author, not the orchestrator it is assigned to")
	assert.Equal(t, "worker", by[plain.ID])
	assert.Equal(t, "", by[free.ID])
	v, err := e.s.ApproveReview(e.ctx, "team", id, "rev1", "ok", 0)
	require.NoError(t, err)
	e.finish(v)
	page, err = e.s.ListTaskPage(e.ctx, "team", TaskListQuery{Status: TaskListCompleted})
	require.NoError(t, err)
	by = map[int64]string{}
	for _, item := range page.Tasks {
		by[item.ID] = item.WorkedBy
	}
	assert.Equal(t, "worker", by[id], "a done task names who built it, not the orchestrator who completed it")
}
