package board

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12869 (from coral-hub #4223): a task "review_pending, given to the orchestrator" seemed to take no command: reassign answered a 500, approve and reject said only "has no open review", and a second
// "review --to" for a name already on the round answered nothing. The state is movable (name reviewers, or complete it); the refusals now say so.

func waitingTask(t *testing.T) (*Store, string, int64) {
	t.Helper()
	s, team := reviewStatesBoard(t)
	all, err := s.ListTasks(t.Context(), team)
	require.NoError(t, err)
	for _, tk := range all {
		if tk.Title == "waiting, not delegated" {
			return s, team, tk.ID
		}
	}
	t.Fatal("no waiting task")
	return nil, "", 0
}

func TestReassigningATaskInReviewIsRefusedWithTheWayToMoveIt(t *testing.T) {
	s, team, id := waitingTask(t)
	_, err := s.ReassignTask(t.Context(), team, id, "Dev2")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrTaskReassignRefused), "a typed refusal the route answers 409, never a 500: %v", err)
	assert.Contains(t, err.Error(), "in review")
	assert.Contains(t, err.Error(), "coral-board task review", "it says what moves the task: name reviewers")
	assert.Contains(t, err.Error(), "coral-board task complete")

	done, err := s.CreateTask(t.Context(), team, "finished", "b", "low", "lead", "Dev")
	require.NoError(t, err)
	_, err = s.ClaimTask(t.Context(), team, "Dev", done.ID)
	require.NoError(t, err)
	_, err = s.CompleteTask(t.Context(), team, done.ID, "Dev", nil)
	require.NoError(t, err)
	_, err = s.ReassignTask(t.Context(), team, done.ID, "Dev2")
	assert.True(t, errors.Is(err, ErrTaskReassignRefused), "a finished task: %v", err)
	assert.Contains(t, err.Error(), "completed")

	_, err = s.ReassignTask(t.Context(), team, 999999, "Dev2")
	assert.False(t, errors.Is(err, ErrTaskReassignRefused), "a task that is not there is not a state refusal")
	assert.Contains(t, err.Error(), "is not on this board")
}

func TestAVerdictOnAWaitingOrEndedRoundSaysWhatToDo(t *testing.T) {
	s, team, id := waitingTask(t)
	ctx := t.Context()
	for name, f := range map[string]func() error{
		"approve": func() error { _, err := s.ApproveReview(ctx, team, id, "lead", "ok", 0); return err },
		"reject":  func() error { _, err := s.RejectReview(ctx, team, id, "lead", "no", 1); return err },
	} {
		err := f()
		require.Error(t, err, name)
		assert.Contains(t, err.Error(), "has no open review", name)
		assert.Contains(t, err.Error(), "nobody has been asked to review it yet", name)
		assert.Contains(t, err.Error(), "coral-board task review", name)
	}

	// a round that ended (every reviewer approved) while the task still waits in review: the verdict says so, and a new round moves it
	_, created, err := s.DelegateReview(ctx, team, id, "lead", []string{"QA"})
	require.NoError(t, err)
	require.Len(t, created, 1)
	_, err = s.ApproveReview(ctx, team, id, "QA", "fine", 0)
	require.NoError(t, err)
	_, err = s.RejectReview(ctx, team, id, "QA", "late", 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "round 1 already ended (approved)")
	assert.Contains(t, err.Error(), "coral-board task complete")
	_, created, err = s.DelegateReview(ctx, team, id, "lead", []string{"Sec"})
	require.NoError(t, err, "a task whose round ended and that still waits can be given a new round")
	assert.Len(t, created, 1)
}
