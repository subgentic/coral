package board

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22133: a saved file that is approved or denied stays saved (the Saved page lists it under Done, as the approved mock shows), and keeps when it was saved; changes requested still takes it off (#11985: the
// agent's turn, not the Operator's).
func TestADecidedSavedFileStaysSavedUnlessChangesAreRequested(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Now()
	for _, c := range []struct {
		hex, state string
		saved      bool
	}{{"app", ReviewApproved, true}, {"den", ReviewDenied, true}, {"chg", ReviewChangesRequested, false}} {
		require.NoError(t, s.SetArtifactTags(ctx, "team", c.hex, []string{"for review", "read"}))
		_, _, err := s.SaveArtifactReview(ctx, "team", c.hex, true)
		require.NoError(t, err)
		_, tags, err := s.DecideArtifactReview(ctx, "team", c.hex, c.state, now)
		require.NoError(t, err)
		assert.Equal(t, c.saved, slices.Contains(tags, "saved"), c.state)
		assert.NotContains(t, tags, "read", c.state)
		if c.saved {
			at, err := s.ArtifactSavedAt(ctx, "team")
			require.NoError(t, err)
			assert.Contains(t, at, c.hex, "%s: it keeps its saved time, for the Saved list's order", c.state)
			assert.NotContains(t, tags, "for review", c.state)
		}
	}
}

// A board message on a task with a goal answers that goal; a message on no task, or on a task with no goal, answers none; another board's ids are not read.
func TestMessageGoalsIsTheGoalOfTheMessagesTask(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g, err := s.CreateGoal(ctx, "team", GoalInput{Title: "Ship Saved", CreatedBy: "Operator"})
	require.NoError(t, err)
	withGoal, err := s.CreateTask(ctx, "team", "Saved server", "", "high", "Orchestrator")
	require.NoError(t, err)
	require.NoError(t, s.SetTaskGoal(ctx, "team", withGoal.ID, &g.ID))
	noGoal, err := s.CreateTask(ctx, "team", "Other", "", "low", "Orchestrator")
	require.NoError(t, err)

	onGoal, err := s.PostMessageForTask(ctx, "team", "Backend Dev", "on the goal's task", nil, "", &withGoal.ID)
	require.NoError(t, err)
	onTask, err := s.PostMessageForTask(ctx, "team", "Backend Dev", "on a task with no goal", nil, "", &noGoal.ID)
	require.NoError(t, err)
	plain, err := s.PostMessage(ctx, "team", "Backend Dev", "on no task", nil)
	require.NoError(t, err)

	got, err := s.MessageGoals(ctx, "team", []int64{onGoal.ID, onTask.ID, plain.ID, 999999})
	require.NoError(t, err)
	assert.Equal(t, map[int64]MessageGoal{onGoal.ID: {ID: g.ID, Title: "Ship Saved"}}, got)

	other, err := s.MessageGoals(ctx, "elsewhere", []int64{onGoal.ID})
	require.NoError(t, err)
	assert.Empty(t, other, "the ids are read on the board asked for only")

	title := "Ship Saved v2"
	_, err = s.UpdateGoal(ctx, "team", g.ID, GoalUpdate{Title: &title})
	require.NoError(t, err)
	got, err = s.MessageGoals(ctx, "team", []int64{onGoal.ID})
	require.NoError(t, err)
	assert.Equal(t, "Ship Saved v2", got[onGoal.ID].Title, "derived when read: the goal's title as it is now")
}
