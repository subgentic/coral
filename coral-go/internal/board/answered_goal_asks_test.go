package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22106: when the bounded scan is cut, the read says where to go on from, even on a page that found nothing, so an older answer stays reachable.
func TestAnsweredAsksForGoalGoesOnPastACutScan(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := s.Subscribe(ctx, "team", who, who, "", nil, "all")
		require.NoError(t, err)
	}
	goal, err := s.CreateGoal(ctx, "team", GoalInput{Title: "Checkout", CreatedBy: "Lead"})
	require.NoError(t, err)
	ask := func(text string) *Message {
		q, err := s.PostMessage(ctx, "team", "Lead", text, nil)
		require.NoError(t, err)
		require.NoError(t, s.RecordAsk(ctx, "team", q, []string{"Operator"}))
		require.NoError(t, s.RecordAskSubject(ctx, "team", q.ID, goal.ID, 0, true))
		return q
	}
	old := ask("@Operator the old one?")
	r, err := s.PostMessage(ctx, "team", "Operator", "yes", nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordReply(ctx, "team", r.ID, old.ID))
	for i := 0; i < 3; i++ {
		ask("@Operator still open?")
	}

	saved := answeredAsksScanMax
	answeredAsksScanMax = 2
	defer func() { answeredAsksScanMax = saved }()
	var got []AnsweredGoalAsk
	before := int64(0)
	for page := 0; page < 5; page++ {
		rows, next, err := s.AnsweredAsksForGoal(ctx, "team", "Operator", goal.ID, 10, before)
		require.NoError(t, err)
		got = append(got, rows...)
		if next == 0 {
			break
		}
		before = next
	}
	require.Len(t, got, 1, "the old answer is reached through the cut scans")
	assert.Equal(t, old.ID, got[0].MessageID)
	assert.Equal(t, "yes", got[0].AnswerText)
}
