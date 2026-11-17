package board

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17673 (walk 77): a worker whose "task complete" is refused because the task is assigned to someone else is told who may complete it and what to do next,
// not only that it is refused.
func TestARefusedCompletionSaysWhoMayCompleteAndWhatToDo(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	task, err := s.CreateTask(ctx, "team", "Build it", "", "medium", "lead", "Developer")
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "team", task.ID, "Developer 2", nil)
	require.Error(t, err)
	var refused *NotAssigneeError
	require.True(t, errors.As(err, &refused), "a refusal to complete another's task is a NotAssigneeError: %v", err)
	assert.Contains(t, err.Error(), "only the assignee, Operator or an active registered orchestrator may complete it", "who may complete it")
	assert.Contains(t, err.Error(), "Ask Developer to complete it", "what to do: the assignee completes it")
	assert.Contains(t, err.Error(), "coral-board task reassign", "what to do when the refused one did the work")
}
