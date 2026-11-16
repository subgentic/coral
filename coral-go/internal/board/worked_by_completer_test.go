package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Walk 77 M7 item 2 (#18299): the Tasks table's WHO column is the board's own record, worked_by: the author of a reviewed task, else whoever completed it, else its assignee. A task assigned to one member
// and completed by another (the Operator or the orchestrator, after the doer's own "complete" was refused) therefore names the one who completed it: nothing records that a third member did the work until that
// member submits it (the author) or is made its assignee. The cure is the refusal's words (#17673: ask for a reassign), not the column.
func TestWHONamesTheCompleterWhenTheAssigneeDidNotComplete(t *testing.T) {
	e := newVerEnv(t)
	task, err := e.s.CreateTask(e.ctx, "team", "assigned to Developer", "", "medium", "lead", "Developer")
	require.NoError(t, err)
	assert.Equal(t, "Developer", e.task(task.ID).WorkedBy, "open: its assignee")

	_, err = e.s.CompleteTask(e.ctx, "team", task.ID, "Developer 2", nil)
	var refused *NotAssigneeError
	require.ErrorAs(t, err, &refused, "a member that is not its assignee cannot complete it")
	assert.Equal(t, "Developer", e.task(task.ID).WorkedBy, "a refused complete records nothing: still its assignee")

	_, err = e.s.CompleteTask(e.ctx, "team", task.ID, "Operator", nil)
	require.NoError(t, err)
	done := e.task(task.ID)
	require.NotNil(t, done.CompletedBy)
	assert.Equal(t, "Operator", *done.CompletedBy)
	assert.Equal(t, "Operator", done.WorkedBy, "completed by someone else: the column names the completer")
}
