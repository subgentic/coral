package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #14421 (Threading S1): every Activity row carries the goal and task it was about, and the read returns them with the titles as they are now, and filters by goal= and task=. The done-when: a goal's ask
// answered, its file approved (through the real handler) and its task completed give three rows with the same goal_id and the right task_id.
func TestTheRecordCarriesAndFiltersByTheGoalAndTaskOfEachRow(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	ctx := context.Background()
	tasks, err := e.h.bs.ListTasks(ctx, "alpha")
	require.NoError(t, err)
	require.NotEmpty(t, tasks)
	var tid int64
	for _, tk := range tasks {
		if tk.Title == "A work" {
			tid = tk.ID
		}
	}
	require.NotZero(t, tid, "the task the file belongs to")
	goal, err := e.h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Ship the importer‮", CreatedBy: "Alice"})
	require.NoError(t, err)
	gid := goal.ID
	require.NoError(t, e.h.bs.SetTaskGoal(ctx, "alpha", tid, &gid))
	meta := board.ActivityMeta{Actor: "local", Source: "local"}

	// 1) the goal's ask, answered
	require.NoError(t, e.h.bs.RecordAskSubject(ctx, "alpha", 41, gid, tid))
	require.NoError(t, e.h.bs.RecordActivity(ctx, meta, board.ActAnswer, "question", "41", "", "alpha"))
	// 2) its file, approved through the real handler: the handler names the file's task
	e.tag(t, `["for review"]`)
	code, out := e.call(t, http.MethodPost, "/api/board/alpha/artifacts/"+e.id+"/review", `{"decision":"approve"}`)
	require.Equal(t, http.StatusOK, code, out)
	// 3) its task, completed
	require.NoError(t, e.h.bs.RecordActivity(ctx, meta, board.ActTaskComplete, "task", itoa(tid), "", "alpha"))
	// and a plain team message, which has no thread
	require.NoError(t, e.h.bs.RecordActivity(ctx, meta, board.ActMessage, "message", "9", "", "alpha"))

	all, out := getActivity(t, act.URL, "", nil)
	require.Equal(t, http.StatusOK, all, out)
	assert.Len(t, out["actions"], 4)

	code, out = getActivity(t, act.URL, "?goal="+itoa(gid), nil)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 3, "the three rows of the goal: the answer, the approval and the completion")
	seen := map[string]bool{}
	for _, r := range rows {
		row := r.(map[string]any)
		seen[row["action"].(string)] = true
		assert.EqualValues(t, gid, row["goal_id"], row["action"])
		assert.EqualValues(t, tid, row["task_id"], row["action"])
		assert.Equal(t, "Ship the importer", row["goal_title"], "the goal's title as it is now, cleaned")
		assert.Equal(t, "A work", row["task_title"])
		assert.NotContains(t, row, "prev_hash")
		assert.NotContains(t, row, "hash")
	}
	assert.Equal(t, map[string]bool{board.ActAnswer: true, board.ActApprove: true, board.ActTaskComplete: true}, seen)

	code, out = getActivity(t, act.URL, "?task="+itoa(tid), nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, out["actions"], 3)
	code, out = getActivity(t, act.URL, "?goal="+itoa(gid+1000), nil)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, out["actions"], "no row is about a goal that has none")
	code, out = getActivity(t, act.URL, "?goal="+itoa(gid)+"&action="+board.ActApprove, nil)
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, out["actions"], 1, "the filters combine")

	// the plain message row has neither key, and no titles
	_, out = getActivity(t, act.URL, "?action="+board.ActMessage, nil)
	msg := out["actions"].([]any)[0].(map[string]any)
	assert.NotContains(t, msg, "goal_id")
	assert.NotContains(t, msg, "task_id")
	assert.NotContains(t, msg, "goal_title")
	assert.NotContains(t, msg, "task_title")

	for _, bad := range []string{"?goal=abc", "?goal=0", "?goal=-3", "?task=x", "?task=0"} {
		code, _ := getActivity(t, act.URL, bad, nil)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

// A title is read live: a goal renamed since the row was written shows its name now, never the one it had; the ids stay.
func TestAGoalRenamedSinceTheRowShowsItsNameNow(t *testing.T) {
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	ctx := context.Background()
	goal, err := e.h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Old name", CreatedBy: "Alice"})
	require.NoError(t, err)
	require.NoError(t, e.h.bs.RecordActivity(ctx, board.ActivityMeta{Actor: "local", Source: "local"}, board.ActGoalEdit, "goal", itoa(goal.ID), "", "alpha"))
	_, out := getActivity(t, act.URL, "?goal="+itoa(goal.ID), nil)
	assert.Equal(t, "Old name", out["actions"].([]any)[0].(map[string]any)["goal_title"])
	renamed := "New name"
	_, err = e.h.bs.UpdateGoal(ctx, "alpha", goal.ID, board.GoalUpdate{Title: &renamed})
	require.NoError(t, err)
	_, out = getActivity(t, act.URL, "?goal="+itoa(goal.ID), nil)
	row := out["actions"].([]any)[0].(map[string]any)
	assert.EqualValues(t, goal.ID, row["goal_id"], "the id stays")
	assert.Equal(t, "New name", row["goal_title"], "the title is read now, not kept with the row")
}

// Through the Hub the owner reads the same fields: coral-hub merges these rows from several computers and passes the new keys on as they are.
func TestTheHubOwnersReadCarriesTheThreadToo(t *testing.T) {
	withLabel(t, "hub-user-1234abcd", nil)
	e := newReviewEnv(t, true)
	act := e.activityServer(t, true)
	ctx := context.Background()
	goal, err := e.h.bs.CreateGoal(ctx, "alpha", board.GoalInput{Title: "Ship it", CreatedBy: "Alice"})
	require.NoError(t, err)
	require.NoError(t, e.h.bs.RecordActivity(ctx, board.ActivityMeta{Actor: "hub:hub-user-1234abcd", Source: "hub"}, board.ActGoalEdit, "goal", itoa(goal.ID), "", "alpha"))
	owner := map[string]string{tunnel.ViaHeader: cloud.ViaSecret(), tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: "hub-user-1234abcd"}
	code, out := getActivity(t, act.URL, "?goal="+itoa(goal.ID), owner)
	require.Equal(t, http.StatusOK, code, out)
	rows := out["actions"].([]any)
	require.Len(t, rows, 1)
	row := rows[0].(map[string]any)
	assert.EqualValues(t, goal.ID, row["goal_id"])
	assert.Equal(t, "Ship it", row["goal_title"])
}
