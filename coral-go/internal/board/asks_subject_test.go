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
