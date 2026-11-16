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
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", about.ID, 7, 42, true))
	goalOnly := askPost(t, s, ctx, "Lead", "@Dev A which design?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", goalOnly.ID, 7, 0, true))

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
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", msg.ID, 7, 42, true))
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
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, true))
	read := func() AskSubject {
		rows, err := s.AskSubjectsOf(ctx, "alpha", []int64{q.ID})
		require.NoError(t, err)
		return rows[q.ID]
	}
	assert.Empty(t, read().MayNoLongerApply)
	_, err = s.ReassignTask(ctx, "alpha", task.ID, "Dev B")
	require.NoError(t, err)
	assert.Equal(t, "task_reassigned", read().MayNoLongerApply)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, true))
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
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", forged.ID, 0, foreign.ID, true))
	guarded, err := s.AskSubjectsOf(ctx, "alpha", []int64{forged.ID})
	require.NoError(t, err)
	assert.Empty(t, guarded[forged.ID].MayNoLongerApply, "the other board's completed state is never disclosed through the caution")
	var snapshots int
	require.NoError(t, s.reader().GetContext(ctx, &snapshots, `SELECT COUNT(*) FROM board_ask_task_snapshots WHERE message_id=?`, forged.ID))
	assert.Zero(t, snapshots, "a foreign task also cannot seed an assignee snapshot")
	deleted, err := s.CreateTask(ctx, "alpha", "Removed task", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)
	gone := askPost(t, s, ctx, "Lead", "@Dev B check this task?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", gone.ID, 0, deleted.ID, true))
	_, err = s.db.ExecContext(ctx, `DELETE FROM board_tasks WHERE board_id='alpha' AND id=?`, deleted.ID)
	require.NoError(t, err)
	goneContext, err := s.AskSubjectsOf(ctx, "alpha", []int64{gone.ID})
	require.NoError(t, err)
	assert.Empty(t, goneContext[gone.ID].MayNoLongerApply, "a missing task is not evidence of reassignment")

}

// Cancellation finishes the linked work but never answers the person's question.
func TestCancelledLinkedTaskMayNoLongerApply(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Obsolete build", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)
	q := askPost(t, s, ctx, "Lead", "@Dev B restart the build?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, true))
	_, err = s.CancelTask(ctx, "alpha", task.ID, "Lead", nil)
	require.NoError(t, err)
	rows, err := s.AskSubjectsOf(ctx, "alpha", []int64{q.ID})
	require.NoError(t, err)
	assert.Equal(t, "task_completed", rows[q.ID].MayNoLongerApply)
	closed, err := s.AskIsClosed(ctx, "alpha", q.ID)
	require.NoError(t, err)
	assert.False(t, closed)
}

// #15078: a question about a task that is in review says so, so the Inbox offers Approve and Request changes; any other state does not.
func TestAskSubjectSaysWhenItsTaskIsInReview(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Review the app", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)
	q := askPost(t, s, ctx, "Lead", "@Dev B approve the app?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, true))
	read := func() AskSubject {
		rows, err := s.AskSubjectsOf(ctx, "alpha", []int64{q.ID})
		require.NoError(t, err)
		return rows[q.ID]
	}
	assert.False(t, read().TaskInReview, "a task not in review")
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET status = 'review_pending' WHERE id = ? AND board_id = 'alpha'`, task.ID)
	require.NoError(t, err)
	assert.True(t, read().TaskInReview, "a task waiting in review")
}

// #17338: completing a task closes every open ask linked to it.
func TestCloseOvertakenAsks_TaskCompleted(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Ship the feature", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)

	q1 := askPost(t, s, ctx, "Lead", "@Dev B deploy now?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q1.ID, 0, task.ID, true))
	q2 := askPost(t, s, ctx, "Lead", "@Dev A ready?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q2.ID, 0, task.ID, true))
	unrelated := askPost(t, s, ctx, "Lead", "@Dev B unrelated?", true, 0)

	n, err := s.CloseOvertakenAsks(ctx, "alpha", task.ID, 0, "Overtaken: task completed")
	require.NoError(t, err)
	assert.Equal(t, 2, n)

	c1, err := s.AskIsClosed(ctx, "alpha", q1.ID)
	require.NoError(t, err)
	assert.True(t, c1, "linked ask is closed")
	c2, err := s.AskIsClosed(ctx, "alpha", q2.ID)
	require.NoError(t, err)
	assert.True(t, c2, "second linked ask is closed")
	cu, err := s.AskIsClosed(ctx, "alpha", unrelated.ID)
	require.NoError(t, err)
	assert.False(t, cu, "unlinked ask stays open")
}

// #17338: creating a goal closes every open ask linked to it.
func TestCloseOvertakenAsks_GoalCreated(t *testing.T) {
	s, ctx := askBoard(t)

	q := askPost(t, s, ctx, "Lead", "@Dev A should we create a goal?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 7, 0, true))

	n, err := s.CloseOvertakenAsks(ctx, "alpha", 0, 7, "Overtaken: goal #7 created")
	require.NoError(t, err)
	assert.Equal(t, 1, n)

	closed, err := s.AskIsClosed(ctx, "alpha", q.ID)
	require.NoError(t, err)
	assert.True(t, closed)
}

// #17338: an already-closed ask is not closed again and the count reflects only newly closed.
func TestCloseOvertakenAsks_AlreadyClosed(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Done task", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)

	q := askPost(t, s, ctx, "Lead", "@Dev B check?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, true))
	require.NoError(t, s.CloseAsk(ctx, "alpha", q.ID, "Operator", "answered in chat"))

	n, err := s.CloseOvertakenAsks(ctx, "alpha", task.ID, 0, "Overtaken: task completed")
	require.NoError(t, err)
	assert.Equal(t, 0, n, "already-closed ask not counted")
}

// #17338: no task or goal id is a no-op.
func TestCloseOvertakenAsks_NoIDs(t *testing.T) {
	s, ctx := askBoard(t)
	n, err := s.CloseOvertakenAsks(ctx, "alpha", 0, 0, "nothing")
	require.NoError(t, err)
	assert.Equal(t, 0, n)
}

// #17338: an auto-linked ask (explicit=false) stays open when its claimed task completes.
func TestCloseOvertakenAsks_AutoLinkedStaysOpen(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Background work", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)

	q := askPost(t, s, ctx, "Lead", "@Dev B question while working?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID, false))

	n, err := s.CloseOvertakenAsks(ctx, "alpha", task.ID, 0, "Overtaken: task completed")
	require.NoError(t, err)
	assert.Equal(t, 0, n, "auto-linked ask must not be closed")

	closed, err := s.AskIsClosed(ctx, "alpha", q.ID)
	require.NoError(t, err)
	assert.False(t, closed, "auto-linked ask stays open")
}

// #17338: an ask with --goal only has its task auto-filled from the claimed task; the row is explicit=false
// because only the goal was named. Completing the auto-filled task must not close the ask.
func TestCloseOvertakenAsks_GoalOnlyWithAutoFilledTask(t *testing.T) {
	s, ctx := askBoard(t)
	task, err := s.CreateTask(ctx, "alpha", "Claimed work", "", "medium", "Lead", "Dev A")
	require.NoError(t, err)

	q := askPost(t, s, ctx, "Lead", "@Dev B should we create a goal?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 7, task.ID, false))

	n, err := s.CloseOvertakenAsks(ctx, "alpha", task.ID, 0, "Overtaken: task completed")
	require.NoError(t, err)
	assert.Equal(t, 0, n, "goal-only ask with auto-filled task must not be closed")

	closed, err := s.AskIsClosed(ctx, "alpha", q.ID)
	require.NoError(t, err)
	assert.False(t, closed, "ask stays open because the task link was not explicit")
}

// #18714: every open question about a finished task leaves Needs you at once (several on one team, not only one); a question about a task still going stays; a second sweep closes nothing more.
func TestQuestionsAboutFinishedTasksAreClosedTogether(t *testing.T) {
	s, ctx := askBoard(t)
	mk := func(title string) (*Task, *Message) {
		task, err := s.CreateTask(ctx, "alpha", title, "", "medium", "Lead", "Dev A")
		require.NoError(t, err)
		q := askPost(t, s, ctx, "Lead", "@Operator about "+title+"?", true, 0)
		require.NoError(t, s.RecordAskSubject(ctx, "alpha", q.ID, 0, task.ID))
		return task, q
	}
	t1, q1 := mk("one")
	t2, q2 := mk("two")
	_, q3 := mk("three, still going")
	for _, task := range []*Task{t1, t2} {
		_, err := s.ClaimTask(ctx, "alpha", "Dev A", task.ID)
		require.NoError(t, err)
		_, err = s.CompleteTask(ctx, "alpha", task.ID, "Dev A", nil)
		require.NoError(t, err)
	}
	n, err := s.CloseAsksOfFinishedTasks(ctx)
	require.NoError(t, err)
	assert.EqualValues(t, 2, n)
	for q, want := range map[int64]bool{q1.ID: true, q2.ID: true, q3.ID: false} {
		closed, err := s.AskIsClosed(ctx, "alpha", q)
		require.NoError(t, err)
		assert.Equal(t, want, closed, "question %d", q)
	}
	n, err = s.CloseAsksOfFinishedTasks(ctx)
	require.NoError(t, err)
	assert.Zero(t, n)
}
