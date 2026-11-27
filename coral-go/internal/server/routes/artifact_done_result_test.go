package routes

import (
	"context"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21811: the finished result still goes to Needs you after the work is closed: a --kind done file attaches to an OPERATOR task that is already completed, and a goal's result (--goal N) is accepted for a closed goal,
// from the Orchestrator or the goal's driver only.
func TestAFinishedResultAttachesToACompletedTaskOrAClosedGoal(t *testing.T) {
	k := newKindRig(t)
	ctx := context.Background()
	op := k.task("OPERATOR fix the thing", "Backend")
	id, _ := strconv.ParseInt(op, 10, 64)
	_, err := k.h.bs.CompleteTask(ctx, "alpha", id, "Backend", nil)
	require.NoError(t, err)

	code, out := k.up("s1", "&kind=done", taskHeader12144(op))
	require.Equal(t, 201, code, out)
	assert.Equal(t, "done", out["kind"])
	code, out = k.up("s1", "", taskHeader12144(op))
	assert.NotEqual(t, 201, code, "a plain file still goes to no completed task: %v", out)
	assert.Contains(t, out["error"], "takes no more files")

	g, err := k.h.bs.CreateGoal(ctx, "alpha", goalInputFor("Fine-tune", "Lead", "Backend"))
	require.NoError(t, err)
	_, _, err = k.h.bs.CloseGoalBy(ctx, "alpha", g.ID, "done", "done", "Lead")
	require.NoError(t, err)
	gs := "&goal=" + strconv.FormatInt(g.ID, 10)
	code, out = k.up("s4", "&kind=done"+gs, nil) // the Orchestrator
	require.Equal(t, 201, code, out)
	code, out = k.up("s1", "&kind=done"+gs, nil) // the driver
	require.Equal(t, 201, code, out)
	code, out = k.up("s2", "&kind=done"+gs, nil) // another member
	assert.Equal(t, 400, code, "not the driver, not the Orchestrator: %v", out)
	code, out = k.up("s4", "&kind=done&goal=9999", nil)
	assert.Equal(t, 400, code, "a goal that is not on the board: %v", out)
	code, out = k.up("s4", "&kind=release"+gs, nil)
	assert.Equal(t, 400, code, "--goal is for --kind done only: %v", out)
}

func goalInputFor(title, by, driver string) board.GoalInput {
	return board.GoalInput{Title: title, CreatedBy: by, Driver: driver}
}
