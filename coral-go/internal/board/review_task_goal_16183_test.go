package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// inReviewOnGoal takes a task that serves goal g to the orchestrator's hand.
func (e *verEnv) inReviewOnGoal(name string, g int64) int64 {
	e.t.Helper()
	task, err := e.s.CreateTaskWithOpts(e.ctx, "team", name, "", "medium", "lead", &CreateTaskOpts{GoalID: &g}, "worker")
	require.NoError(e.t, err)
	_, err = e.s.ClaimTask(e.ctx, "team", "worker", task.ID)
	require.NoError(e.t, err)
	_, err = e.s.SubmitCompletionReview(e.ctx, "team", task.ID, "worker", "built", "success", "needs review", []TaskArtifact{patchRow("fix", "d1")})
	require.NoError(e.t, err)
	_, _, err = e.s.HandToOrchestrator(e.ctx, "team", task.ID, "worker")
	require.NoError(e.t, err)
	return task.ID
}

// #16183: a review task Coral makes serves the goal of the task it reviews, in the first round and for a reviewer added later; a reviewed task with no goal, or a closed one, leaves it with none.
func TestAReviewTaskServesTheReviewedTasksGoal(t *testing.T) {
	e := newVerEnv(t)
	g := newGoal(t, e.s, "team", "Ship")
	id := e.inReviewOnGoal("work", g.ID)
	setRequireGoal(t, e.s, "team", true)

	_, made, err := e.s.DelegateReview(e.ctx, "team", id, "lead", []string{"rev1"})
	require.NoError(t, err)
	require.Len(t, made, 1)
	require.NotNil(t, made[0].GoalID, "the review task has the goal")
	assert.Equal(t, g.ID, *made[0].GoalID)

	// A reviewer named while the round is open gets a review task on the same goal.
	_, made, err = e.s.DelegateReview(e.ctx, "team", id, "lead", []string{"rev1", "rev2"})
	require.NoError(t, err)
	require.Len(t, made, 1)
	require.NotNil(t, made[0].GoalID)
	assert.Equal(t, g.ID, *made[0].GoalID)

	// A reviewed task with no goal (an older task): the review task has none and is still exempt.
	setRequireGoal(t, e.s, "team", false)
	bare := e.inReviewNoDelegate("older", "rev1")
	setRequireGoal(t, e.s, "team", true)
	_, made, err = e.s.DelegateReview(e.ctx, "team", bare, "lead", []string{"rev1"})
	require.NoError(t, err)
	assert.Nil(t, made[0].GoalID)

	// A closed goal is not continued under.
	h := newGoal(t, e.s, "team", "Later")
	closed := e.inReviewOnGoal("late", h.ID)
	_, _, err = e.s.CloseGoal(e.ctx, "team", h.ID, "done", "done")
	require.NoError(t, err)
	_, made, err = e.s.DelegateReview(e.ctx, "team", closed, "lead", []string{"rev1"})
	require.NoError(t, err)
	assert.Nil(t, made[0].GoalID)
}
