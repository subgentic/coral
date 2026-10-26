package main

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7791, goal #21: task add --follow-up <id> makes a child task that takes the parent's goal, reviewers and assignee unless the caller gave their own, and links itself to the parent.
func TestTaskAddFollowUpInheritsFromTheParent(t *testing.T) {
	srv := newAssignServer(t)
	srv.tasks[40] = map[string]any{"id": 40, "goal_id": 21, "assigned_to": "Orchestrator", "worked_by": "Backend Dev", "status": "completed",
		"workflow": map[string]any{"reviewers": []any{"Security Reviewer", "QA Engineer"}}}
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "task", "add", "Fix the review notes", "--follow-up", "40")
	require.Equal(t, 0, res.code, res.stderr)
	require.Len(t, srv.created, 1)
	got := srv.created[0]
	assert.EqualValues(t, 21, got["goal_id"], "the parent's goal")
	assert.Equal(t, "Backend Dev", got["assigned_to"], "who did the parent's work, not the orchestrator it sat with in review")
	wf, _ := got["workflow"].(map[string]any)
	assert.EqualValues(t, 40, wf["parent_task_id"], "linked to the parent")
	assert.Equal(t, []any{"Security Reviewer", "QA Engineer"}, wf["reviewers"], "the parent's reviewers")
	assert.Contains(t, res.stdout, "Created Task #900: Fix the review notes")
	assert.Contains(t, res.stdout, "A follow-up of task #40")

	// the caller's own choices win
	res = runBoard(t, srv.URL, dir, "task", "add", "Second", "--follow-up", "40", "--assignee", "Lead Developer", "--goal", "3", "--reviewers", "QA Engineer")
	require.Equal(t, 0, res.code, res.stderr)
	got = srv.created[1]
	assert.Equal(t, "Lead Developer", got["assigned_to"])
	assert.EqualValues(t, 3, got["goal_id"])
	wf, _ = got["workflow"].(map[string]any)
	assert.Equal(t, []any{"QA Engineer"}, wf["reviewers"])
	assert.EqualValues(t, 40, wf["parent_task_id"])
}

func TestTaskAddFollowUpOfATaskWithNoGoalOrWorkerTakesWhatThereIs(t *testing.T) {
	srv := newAssignServer(t)
	srv.tasks[41] = map[string]any{"id": 41, "assigned_to": "Dev A", "status": "in_progress", "workflow": map[string]any{}}
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "task", "add", "More", "--follow-up", "41")
	require.Equal(t, 0, res.code, res.stderr)
	got := srv.created[0]
	assert.Equal(t, "Dev A", got["assigned_to"], "no worker yet: who has it")
	assert.NotContains(t, got, "goal_id", "a parent on no goal gives none")
}

func TestTaskAddFollowUpRefusesWhatItCannotFollow(t *testing.T) {
	srv := newAssignServer(t)
	srv.tasks[40] = map[string]any{"id": 40, "status": "completed", "workflow": map[string]any{}}
	dir := subscribedDataDir(t, srv.URL)
	res := runBoard(t, srv.URL, dir, "task", "add", "x", "--follow-up", "99")
	assert.NotZero(t, res.code)
	assert.Contains(t, res.stderr, "task #99 is not on this board")
	for _, extra := range [][]string{{"--parent", "5"}, {"--retry-of", "5"}, {"--goal-from", "5"}} {
		res = runBoard(t, srv.URL, dir, append([]string{"task", "add", "x", "--follow-up", "40"}, extra...)...)
		assert.NotZero(t, res.code, "%v", extra)
		assert.Contains(t, res.stderr, "--follow-up can't be combined", "%v", extra)
	}
	res = runBoard(t, srv.URL, dir, "task", "add", "x", "--follow-up", "0")
	assert.Zero(t, res.code, "--follow-up 0 is no follow-up: a plain task")
	tasks, _ := srv.counts()
	assert.Equal(t, 1, tasks, "only the plain one was created")
}

// task show prints what a task followed and what followed it.
func TestTaskShowListsTheFollowUpsAndTheTaskItFollows(t *testing.T) {
	data := []byte(`{"id":40,"title":"Build it","status":"completed","priority":"high","assigned_to":null,"created_by":"Orch","follow_ups":[
		{"id":41,"title":"Fix the notes","status":"in_progress","assigned_to":"Dev A"},{"id":42,"title":"Add the test","status":"completed","assigned_to":null}],
		"workflow":{"outcome":"success"}}`)
	show, err := parseTaskShow(data)
	require.NoError(t, err)
	require.Len(t, show.FollowUps, 2)
	var out bytes.Buffer
	printTaskShow(&out, show)
	assert.Contains(t, out.String(), "Follow-ups (2, 1 open):")
	assert.Contains(t, out.String(), "#41  [in_progress]  Fix the notes  (Dev A)")
	assert.Contains(t, out.String(), "#42  [completed]  Add the test")
	assert.NotContains(t, out.String(), "Follow-up of task")

	child, err := parseTaskShow([]byte(`{"id":41,"title":"Fix the notes","status":"pending","workflow":{"parent_task_id":40}}`))
	require.NoError(t, err)
	out.Reset()
	printTaskShow(&out, child)
	assert.Contains(t, out.String(), "Follow-up of task #40")
	assert.NotContains(t, out.String(), "Follow-ups (")
}
