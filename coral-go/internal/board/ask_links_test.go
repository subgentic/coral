package board

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17738: an ask linked to an earlier open one (post --ask --same-as N) shares its key (the first ask's id), and one answer closes every ask of the key.
func TestLinkedAsksShareAKeyAndOneAnswerClosesAll(t *testing.T) {
	s, ctx := askBoard(t)
	first := askPost(t, s, ctx, "Lead", "@Dev A which parser?", true, 0)
	second := askPost(t, s, ctx, "Dev B", "@Dev A which parser do we use?", true, 0)
	third := askPost(t, s, ctx, "Dev B", "@Dev A parser again?", true, 0)
	plain := askPost(t, s, ctx, "Lead", "@Dev A something else?", true, 0)
	require.NoError(t, s.LinkAsk(ctx, "alpha", second.ID, first.ID))
	require.NoError(t, s.LinkAsk(ctx, "alpha", third.ID, second.ID), "linking to a linked ask joins its key")

	keys, err := s.AskKeysOf(ctx, "alpha", []int64{first.ID, second.ID, third.ID, plain.ID})
	require.NoError(t, err)
	assert.Equal(t, map[int64]int64{first.ID: first.ID, second.ID: first.ID, third.ID: first.ID}, keys, "the first ask is the key; an unlinked ask has none")

	assert.False(t, askOf(t, s, ctx, second.ID).Answered)
	askPost(t, s, ctx, "Dev A", "Use the new one.", false, 0)
	_ = askPost(t, s, ctx, "Dev A", "Use the new one.", false, second.ID) // an answer to the second only
	for _, id := range []int64{first.ID, second.ID, third.ID} {
		assert.True(t, askOf(t, s, ctx, id).Answered, "ask %d is answered by the one reply", id)
	}
	assert.False(t, askOf(t, s, ctx, plain.ID).Answered, "an unlinked ask is not touched")
}

func TestLinkingNeedsAnAskOfTheBoard(t *testing.T) {
	s, ctx := askBoard(t)
	q := askPost(t, s, ctx, "Lead", "@Dev A which parser?", true, 0)
	msg := askPost(t, s, ctx, "Dev B", "just a post", false, 0)
	assert.ErrorIs(t, s.LinkAsk(ctx, "alpha", q.ID, 9999), ErrAskUnknown, "no such ask to link to")
	assert.ErrorIs(t, s.LinkAsk(ctx, "alpha", q.ID, msg.ID), ErrAskUnknown, "a post that is no ask")
	q2 := askPost(t, s, ctx, "Dev B", "@Dev A parser?", true, 0)
	assert.ErrorIs(t, s.LinkAsk(ctx, "beta", q2.ID, q.ID), ErrAskUnknown, "another board's asks")
	assert.Error(t, s.LinkAsk(ctx, "alpha", q.ID, q.ID), "an ask is not the same as itself")
}

// #17738: closing a goal resolves its open asks (closed with a note, not approved) and says whose they were; answered and other goals' asks are left.
func TestClosingAGoalRetiresItsOpenAsks(t *testing.T) {
	s, ctx := askBoard(t)
	g, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Ship", CreatedBy: "Lead"})
	require.NoError(t, err)
	other, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: "Other", CreatedBy: "Lead"})
	require.NoError(t, err)
	open := askPost(t, s, ctx, "Lead", "@Dev A ship it?", true, 0)
	answered := askPost(t, s, ctx, "Dev B", "@Dev A ship it too?", true, 0)
	elsewhere := askPost(t, s, ctx, "Lead", "@Dev A other?", true, 0)
	nogoal := askPost(t, s, ctx, "Lead", "@Dev A no goal?", true, 0)
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", open.ID, g.ID, 0))
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", answered.ID, g.ID, 0))
	require.NoError(t, s.RecordAskSubject(ctx, "alpha", elsewhere.ID, other.ID, 0))
	askPost(t, s, ctx, "Dev A", "yes", false, answered.ID)

	got, err := s.RetireGoalAsks(ctx, "alpha", g.ID, "goal closed as done", time.Now())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, RetiredAsk{ID: open.ID, Asker: "Lead"}, got[0])
	info := askOf(t, s, ctx, open.ID)
	assert.True(t, info.Closed)
	assert.Contains(t, info.ClosedNote, "goal closed")
	assert.False(t, askOf(t, s, ctx, elsewhere.ID).Answered)
	assert.False(t, askOf(t, s, ctx, nogoal.ID).Answered)
	again, err := s.RetireGoalAsks(ctx, "alpha", g.ID, "goal closed as done", time.Now())
	require.NoError(t, err)
	assert.Empty(t, again, "closed asks are not retired twice")
}
