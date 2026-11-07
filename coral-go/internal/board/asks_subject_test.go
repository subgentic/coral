package board

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #12164 (the Operator: "attach the goal and task the question is about"): a question carries the goal and the task it is about, kept on the ask, read back by message id.
func TestAnAskKeepsTheGoalAndTaskItIsAbout(t *testing.T) {
	s, ctx := askBoard(t)
	plain := askPost(t, s, ctx, "Lead", "@Dev A which parser?", true, 0)
	about := askPost(t, s, ctx, "Lead", "@Dev B ship it?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", about.ID, 7, 42))
	goalOnly := askPost(t, s, ctx, "Lead", "@Dev A which design?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", goalOnly.ID, 7, 0))

	got, err := s.AskSubjectsOf(ctx, "alpha", []int64{plain.ID, about.ID, goalOnly.ID, 9999})
	require.NoError(t, err)
	assert.Equal(t, AskSubject{GoalID: 7, TaskID: 42}, got[about.ID])
	assert.Equal(t, AskSubject{GoalID: 7}, got[goalOnly.ID])
	assert.NotContains(t, got, plain.ID, "a question with neither has no row of subjects")
	assert.NotContains(t, got, int64(9999))

	// only this board's asks; nothing for another board's id
	other, err := s.AskSubjectsOf(ctx, "beta", []int64{about.ID})
	require.NoError(t, err)
	assert.Empty(t, other)
	// nothing is recorded for a message that is not an ask
	msg, err := s.PostMessage(ctx, "alpha", "Lead", "just a post", nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", msg.ID, 7, 42))
	again, err := s.AskSubjectsOf(ctx, "alpha", []int64{msg.ID})
	require.NoError(t, err)
	assert.Empty(t, again, "a post that is not a question carries no subject")
	// an empty list asks nothing
	none, err := s.AskSubjectsOf(ctx, "alpha", nil)
	require.NoError(t, err)
	assert.Empty(t, none)
}

// A linked question is cautioned, never answered or closed, when its task changes course.
func TestAskTaskContextWarnsWithoutClosingTheQuestion(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Check the build", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)
	q := askPost(t, s, ctx, "Lead", "@Dev B restart the build?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID))
	read := func() AskSubject {
		rows, err := s.AskSubjectsOf(ctx, "alpha", []int64{q.ID})
		require.NoError(t, err)
		return rows[q.ID]
	}
	assert.Empty(t, read().MayNoLongerApply)
	_, err = s.ReassignTask(ctx, "alpha", task.ID, "Dev B")
	require.NoError(t, err)
	assert.Equal(t, "task_reassigned", read().MayNoLongerApply)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID))
	assert.Equal(t, "task_reassigned", read().MayNoLongerApply, "recording the same subject again preserves its original assignee")
	// A pre-upgrade question has no assignee snapshot: do not invent its earlier assignment.
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_ask_task_snapshots WHERE message_id=?`, q.ID)
	require.NoError(t, err)
	assert.Empty(t, read().MayNoLongerApply)
	_, err = s.ClaimTask(ctx, "alpha", "Dev B", task.ID)
	require.NoError(t, err)
	_, err = s.CompleteTask(ctx, "alpha", task.ID, "Dev B", nil)
	require.NoError(t, err)
	assert.Equal(t, "task_completed", read().MayNoLongerApply, "completion is known even for an older question")
	closed, err := s.AskIsClosed(ctx, "alpha", q.ID)
	require.NoError(t, err)
	assert.False(t, closed, "a warning does not close or answer the question")
	other, err := s.AskSubjectsOf(ctx, "beta", []int64{q.ID})
	require.NoError(t, err)
	assert.Empty(t, other, "another board sees no task context")
	// Even a forged store-level link must not read a different board's task state.
	foreign, err := s.CreateTask(ctx, "beta", "Private task", "", "medium", "Lead")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status='completed' WHERE board_id='beta' AND id=?`, foreign.ID)
	require.NoError(t, err)
	forged := askPost(t, s, ctx, "Lead", "@Dev B unrelated question", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", forged.ID, 0, foreign.ID))
	guarded, err := s.AskSubjectsOf(ctx, "alpha", []int64{forged.ID})
	require.NoError(t, err)
	assert.Empty(t, guarded[forged.ID].MayNoLongerApply, "the other board's completed state is never disclosed through the caution")
	var snapshots int
	require.NoError(t, s.reader().GetContext(ctx, &snapshots, `SELECT COUNT(*) FROM board_ask_task_snapshots WHERE message_id=?`, forged.ID))
	assert.Zero(t, snapshots, "a foreign task also cannot seed an assignee snapshot")
	deleted, err := s.CreateTask(ctx, "alpha", "Removed task", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)
	gone := askPost(t, s, ctx, "Lead", "@Dev B check this task?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", gone.ID, 0, deleted.ID))
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_tasks WHERE board_id='alpha' AND id=?`, deleted.ID)
	require.NoError(t, err)
	goneContext, err := s.AskSubjectsOf(ctx, "alpha", []int64{gone.ID})
	require.NoError(t, err)
	assert.Empty(t, goneContext[gone.ID].MayNoLongerApply, "a missing task is not evidence of reassignment")

}
