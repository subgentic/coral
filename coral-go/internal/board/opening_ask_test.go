package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19170 (walk F11): the Orchestrator's opening question to the Operator ("What should the team build?") stays open in Needs you after the Operator answers it by creating the team's first goal. The board's first question
// to the Operator, put while the board has no goal, is marked as its opening question; the first goal closes it with a note naming the goal, and nothing else.
func openingAsk(t *testing.T, s *Store, ctx context.Context, who, text string) *Message {
	t.Helper()
	m, err := s.PostMessage(ctx, "alpha", who, text, nil)
	require.NoError(t, err)
	asked := []string{OperatorName}
	require.NoError(t, s.RecordAsk(ctx, "alpha", m, asked))
	_, err = s.MarkOpeningAsk(ctx, "alpha", m.ID, asked)
	require.NoError(t, err)
	return m
}

func firstTeamGoal(t *testing.T, s *Store, ctx context.Context, title string) *Goal {
	t.Helper()
	g, err := s.CreateGoal(ctx, "alpha", GoalInput{Title: title, CreatedBy: "Operator"})
	require.NoError(t, err)
	return g
}

func TestTheFirstGoalClosesTheMarkedOpeningAskWithANoteNamingIt(t *testing.T) {
	s, ctx := askBoard(t)
	open := openingAsk(t, s, ctx, "Lead", "What should the team build?")
	assert.False(t, askOf(t, s, ctx, open.ID).Closed)
	g := firstTeamGoal(t, s, ctx, "Ship the recipe app")
	closed, err := s.CloseOpeningAsk(ctx, "alpha", g)
	require.NoError(t, err)
	assert.True(t, closed)
	info := askOf(t, s, ctx, open.ID)
	assert.True(t, info.Closed)
	assert.Contains(t, info.ClosedNote, "goal #", "the note names the goal")
	assert.Contains(t, info.ClosedNote, g.Title)
}

func TestASecondGoalClosesNothing(t *testing.T) {
	s, ctx := askBoard(t)
	first := firstTeamGoal(t, s, ctx, "First")
	// a question put after the board has a goal is not an opening question: it is never marked
	later := openingAsk(t, s, ctx, "Lead", "Which colour?")
	second := firstTeamGoal(t, s, ctx, "Second")
	closed, err := s.CloseOpeningAsk(ctx, "alpha", second)
	require.NoError(t, err)
	assert.False(t, closed)
	assert.False(t, askOf(t, s, ctx, later.ID).Closed)
	// and the first goal, called again after the fact, still has nothing marked to close
	closed, err = s.CloseOpeningAsk(ctx, "alpha", first)
	require.NoError(t, err)
	assert.False(t, closed)
}

func TestAnUnmarkedAskStaysOpenWhenTheFirstGoalIsCreated(t *testing.T) {
	s, ctx := askBoard(t)
	open := openingAsk(t, s, ctx, "Lead", "What should the team build?")
	other := openingAsk(t, s, ctx, "Lead", "Dark mode or light?") // the board's second question: not the opening one
	g := firstTeamGoal(t, s, ctx, "Ship it")
	closed, err := s.CloseOpeningAsk(ctx, "alpha", g)
	require.NoError(t, err)
	assert.True(t, closed)
	assert.True(t, askOf(t, s, ctx, open.ID).Closed)
	assert.False(t, askOf(t, s, ctx, other.ID).Closed, "an ask that was not marked stays open")
	// a question to a member is never the opening question either
	s2, ctx2 := askBoard(t)
	m, err := s2.PostMessage(ctx2, "alpha", "Lead", "@Dev A which parser?", nil)
	require.NoError(t, err)
	require.NoError(t, s2.RecordAsk(ctx2, "alpha", m, []string{"Dev A"}))
	marked, err := s2.MarkOpeningAsk(ctx2, "alpha", m.ID, []string{"Dev A"})
	require.NoError(t, err)
	assert.False(t, marked)
}
