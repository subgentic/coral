package board

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #8501 (the Who column, #8492): a task list item names the reviewers of the current review round, or of the last one when no round is open.
func TestTaskListItemNamesTheReviewersOfTheCurrentOrLastRound(t *testing.T) {
	e := newVerEnv(t)
	list := func() map[int64]TaskListItem {
		page, err := e.s.ListTaskPage(e.ctx, "team", TaskListQuery{Status: TaskListAll, Limit: 50})
		require.NoError(t, err)
		out := map[int64]TaskListItem{}
		for _, it := range page.Tasks {
			out[it.ID] = it
		}
		return out
	}

	plain, err := e.s.CreateTask(e.ctx, "team", "plain", "", "medium", "lead", "worker")
	require.NoError(t, err)
	reviewed := e.inReview("reviewed", []TaskArtifact{patchRow("fix", "d1")}, "rev1", "rev2")

	items := list()
	assert.Equal(t, []string{"rev1", "rev2"}, items[reviewed].Reviewers, "a task in review names who reviews it")
	assert.Empty(t, items[plain.ID].Reviewers, "a task nobody reviews names no one")
	raw, err := json.Marshal(items[plain.ID])
	require.NoError(t, err)
	assert.NotContains(t, string(raw), `"reviewers"`, "and sends no key")
	raw, err = json.Marshal(items[reviewed])
	require.NoError(t, err)
	assert.Contains(t, string(raw), `"reviewers":["rev1","rev2"]`)

	_, err = e.s.RejectReview(e.ctx, "team", reviewed, "rev1", "no", 0)
	require.NoError(t, err)
	assert.Equal(t, []string{"rev1", "rev2"}, list()[reviewed].Reviewers, "a round that went back to the author is the last round: its reviewers stay")

	approved := e.inReview("approved", []TaskArtifact{patchRow("fix2", "d2")}, "rev2")
	v, err := e.s.ApproveReview(e.ctx, "team", approved, "rev2", "ok", 0)
	require.NoError(t, err)
	e.finish(v)
	assert.Equal(t, []string{"rev2"}, list()[approved].Reviewers, "a finished task keeps the reviewers who approved it")

	open, err := e.s.ListTaskPage(e.ctx, "team", TaskListQuery{})
	require.NoError(t, err)
	var seen bool
	for _, it := range open.Tasks {
		if it.ID == reviewed {
			seen = true
			assert.Equal(t, []string{"rev1", "rev2"}, it.Reviewers, "the default list too")
		}
	}
	assert.True(t, seen)
}

// The list of a goal's tasks names the reviewers too.
func TestGoalTaskPageNamesTheReviewers(t *testing.T) {
	e := newVerEnv(t)
	g, err := e.s.CreateGoal(e.ctx, "team", GoalInput{Title: "A goal", CreatedBy: "lead"})
	require.NoError(t, err)
	task, err := e.s.CreateTaskWithOpts(e.ctx, "team", "goal task", "", "medium", "lead", &CreateTaskOpts{GoalID: &g.ID}, "worker")
	require.NoError(t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
	require.NoError(t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", task.ID, "worker", "built", "success", "needs review", []TaskArtifact{patchRow("fix", "d1")})
	require.NoError(t, err)
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", task.ID, "worker")
	require.NoError(t, err)
	_, _, err = e.s.DelegateReview(e.ctx, "team", task.ID, "lead", []string{"rev1", "rev2"})
	require.NoError(t, err)

	page, err := e.s.GoalTaskPage(e.ctx, "team", g.ID, "", "", TaskListMaxLimit)
	require.NoError(t, err)
	var found bool
	for _, it := range page.Tasks {
		if it.ID == task.ID {
			found = true
			assert.Equal(t, []string{"rev1", "rev2"}, it.Reviewers)
		}
	}
	assert.True(t, found)
}

// With more than one round, the item names the newest round's reviewers, not the first's; a workflow with no rounds, or a round with no reviewers, names no one.
func TestTaskListItemTakesTheNewestRoundsReviewers(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	mk := func(title, workflow string) int64 {
		task, err := s.CreateTask(ctx, "alpha", title, "", "medium", "Lead")
		require.NoError(t, err)
		putWorkflow(t, s, task.ID, workflow)
		return task.ID
	}
	two := mk("two rounds", `{"review_rounds":[{"round":1,"reviewers":[{"reviewer":"Old A"}]},{"round":2,"reviewers":[{"reviewer":"New B"},{"reviewer":"New C"}]}]}`)
	none := mk("no rounds", `{"outcome":"success"}`)
	empty := mk("empty round", `{"review_rounds":[{"round":1,"reviewers":[]}]}`)

	page, err := s.ListTaskPage(ctx, "alpha", TaskListQuery{Status: TaskListAll})
	require.NoError(t, err)
	got := map[int64][]string{}
	for _, it := range page.Tasks {
		got[it.ID] = it.Reviewers
	}
	assert.Equal(t, []string{"New B", "New C"}, got[two])
	assert.Empty(t, got[none])
	assert.Empty(t, got[empty])
}
