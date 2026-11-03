package board

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Which asks with buttons are OPEN (#12610): the asker's cap of ten counts questions that still need the Operator, not ones they answered in words or that went stale.

func buttonAsk(t *testing.T, s *Store, ctx context.Context, now time.Time, raw ...string) *Message {
	t.Helper()
	q := askPost(t, s, ctx, "Lead", "@Operator which one?", true, 0)
	buttons, err := ParseAskButtons(raw, nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordAskButtons(ctx, "alpha", q.ID, buttons, now))
	return q
}

func operatorBoard(t *testing.T) (*Store, context.Context) {
	s, ctx := askBoard(t)
	_, err := s.Subscribe(ctx, "alpha", "Operator", "Operator", "", nil, "")
	require.NoError(t, err)
	return s, ctx
}

func buttonStates(t *testing.T, s *Store, ctx context.Context, q *Message) []string {
	t.Helper()
	got, err := s.AskButtonsOf(ctx, "alpha", []int64{q.ID})
	require.NoError(t, err)
	var out []string
	for _, b := range got[q.ID] {
		out = append(out, b.State)
	}
	return out
}

func openCount(t *testing.T, s *Store, ctx context.Context) int {
	t.Helper()
	n, err := s.OpenButtonAsks(ctx, "alpha", "Lead")
	require.NoError(t, err)
	return n
}

func TestTheOperatorsTypedReplyFreesTheSlotsOfTheQuestionsItAnswered(t *testing.T) {
	s, ctx := operatorBoard(t)
	var qs []*Message
	for i := 0; i < AskButtonsOpenMax; i++ {
		qs = append(qs, buttonAsk(t, s, ctx, time.Now(), "Yes=reply", "Wake Dev A=wake:Dev A"))
	}
	require.Equal(t, AskButtonsOpenMax, openCount(t, s, ctx))

	askPost(t, s, ctx, "Operator", "@Lead the second one is fine too", false, 0) // tags the asker, replies to nothing: it answers no button question (#12490: one post must not clear them all)
	assert.Equal(t, AskButtonsOpenMax, openCount(t, s, ctx), "a post that only tags the asker leaves every earlier button question pending")
	assert.Equal(t, []string{ButtonPending, ButtonPending}, buttonStates(t, s, ctx, qs[1]))

	askPost(t, s, ctx, "Operator", "yes, go ahead", false, qs[0].ID) // a typed reply TO it
	askPost(t, s, ctx, "Operator", "@Lead I see", false, qs[2].ID)   // a reply to another one that tags the asker: it answers only that one

	assert.Equal(t, AskButtonsOpenMax-2, openCount(t, s, ctx), "only the two questions answered with a reply to them are resolved")
	assert.Equal(t, []string{ButtonClosed, ButtonClosed}, buttonStates(t, s, ctx, qs[0]), "its buttons are resolved, not left pending")
	assert.Equal(t, []string{ButtonClosed, ButtonClosed}, buttonStates(t, s, ctx, qs[2]))
	assert.Equal(t, []string{ButtonPending, ButtonPending}, buttonStates(t, s, ctx, qs[1]))
}

func TestAWakeButtonPendingMoreThanADayExpiresAndAReplyButtonDoesNot(t *testing.T) {
	s, ctx := operatorBoard(t)
	old := time.Now().Add(-25 * time.Hour)
	onlyWake := buttonAsk(t, s, ctx, old, "Wake Dev A=wake:Dev A")
	mixed := buttonAsk(t, s, ctx, old, "Yes=reply", "Wake Dev B=wake:Dev B")
	fresh := buttonAsk(t, s, ctx, time.Now().Add(-time.Hour), "Wake Dev A=wake:Dev A")

	assert.Equal(t, 2, openCount(t, s, ctx), "the stale wake-only question is out; the one with a reply button and the fresh one remain")
	assert.Equal(t, []string{ButtonExpired}, buttonStates(t, s, ctx, onlyWake))
	assert.Equal(t, []string{ButtonPending, ButtonExpired}, buttonStates(t, s, ctx, mixed))
	assert.Equal(t, []string{ButtonPending}, buttonStates(t, s, ctx, fresh))
}

func TestAMigrationResolvesTheButtonsOfQuestionsAlreadyAnswered(t *testing.T) {
	s, ctx := operatorBoard(t)
	answered := buttonAsk(t, s, ctx, time.Now(), "Yes=reply")
	waiting := buttonAsk(t, s, ctx, time.Now(), "Yes=reply")
	askPost(t, s, ctx, "Operator", "done", false, answered.ID)
	askPost(t, s, ctx, "Operator", "@Lead thanks", false, 0) // tags the asker only: answers neither question

	require.NoError(t, s.ResolveAskButtons(ctx, time.Now()))

	assert.Equal(t, []string{ButtonClosed}, buttonStates(t, s, ctx, answered))
	assert.Equal(t, []string{ButtonPending}, buttonStates(t, s, ctx, waiting))
	require.NoError(t, s.ResolveAskButtons(ctx, time.Now()), "running it again changes nothing")
	assert.Equal(t, []string{ButtonPending}, buttonStates(t, s, ctx, waiting))
}

func TestAskerWithdrawingItsQuestionFreesTheSlot(t *testing.T) {
	s, ctx := operatorBoard(t)
	q := buttonAsk(t, s, ctx, time.Now(), "Yes=reply")
	require.Equal(t, 1, openCount(t, s, ctx))
	require.NoError(t, s.CloseAsk(ctx, "alpha", q.ID, "Lead", "withdrawn"))
	assert.Equal(t, 0, openCount(t, s, ctx))
}

func TestSeveralWakeButtonsOfOneQuestionCanEachBeClaimedOnce(t *testing.T) {
	s, ctx := operatorBoard(t)
	q := buttonAsk(t, s, ctx, time.Now(), "Wake Dev A=wake:Dev A", "Wake Dev B=wake:Dev B", "Open=open:new-agent")
	got, err := s.AskButtonsOf(ctx, "alpha", []int64{q.ID})
	require.NoError(t, err)
	b := got[q.ID]

	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[0].ID, time.Now())
	require.NoError(t, err)
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[1].ID, time.Now())
	assert.NoError(t, err, "a second wake is not blocked by the first")
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[0].ID, time.Now())
	assert.ErrorIs(t, err, ErrButtonUsed, "each wake once")
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[2].ID, time.Now())
	assert.NoError(t, err, "an open button is never held up by a wake: it is not a choice (#12785)")

	// A reply claimed first blocks the wakes, as before.
	r := buttonAsk(t, s, ctx, time.Now(), "Yes=reply", "Wake Dev A=wake:Dev A")
	rb, _ := s.AskButtonsOf(ctx, "alpha", []int64{r.ID})
	_, err = s.ClaimAskButton(ctx, "alpha", r.ID, rb[r.ID][0].ID, time.Now())
	require.NoError(t, err)
	_, err = s.ClaimAskButton(ctx, "alpha", r.ID, rb[r.ID][1].ID, time.Now())
	assert.ErrorIs(t, err, ErrButtonUsed)
}

// A board database that already holds a pending button on an answered question is cleaned when the store opens (#12610).
func TestOpeningABoardResolvesTheButtonsOfAnsweredQuestions(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStoreWithKey(dir+"/board.db", "")
	require.NoError(t, err)
	ctx := context.Background()
	for _, who := range []string{"Lead", "Operator"} {
		_, err := s.Subscribe(ctx, "alpha", who, who, "", nil, "")
		require.NoError(t, err)
	}
	q := askPost(t, s, ctx, "Lead", "@Operator which one?", true, 0)
	buttons, err := ParseAskButtons([]string{"Yes=reply"}, nil)
	require.NoError(t, err)
	require.NoError(t, s.RecordAskButtons(ctx, "alpha", q.ID, buttons, time.Now()))
	askPost(t, s, ctx, "Operator", "yes", false, q.ID)
	_, err = s.db.ExecContext(ctx, `UPDATE board_ask_buttons SET state = 'pending'`) // as an older Coral left it
	require.NoError(t, err)
	require.NoError(t, s.Close())

	again, err := NewStoreWithKey(dir+"/board.db", "")
	require.NoError(t, err)
	t.Cleanup(func() { again.Close() })
	assert.Equal(t, []string{ButtonClosed}, buttonStates(t, again, ctx, q))
}

// #12785: an open button (document, task, new agent) is reusable: never marked used, never blocks a reply or wake, never blocks another open; only a closed question refuses it.
func TestAnOpenButtonIsNeverClaimedAndBlocksNothing(t *testing.T) {
	s, ctx := operatorBoard(t)
	q := buttonAsk(t, s, ctx, time.Now(), "Doc=open:task:12", "New=open:new-agent", "Yes=reply")
	got, err := s.AskButtonsOf(ctx, "alpha", []int64{q.ID})
	require.NoError(t, err)
	b := got[q.ID]
	for i := 0; i < 3; i++ {
		for _, j := range []int{0, 1} {
			_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[j].ID, time.Now())
			require.NoError(t, err, "open button %d, click %d", j, i)
		}
	}
	after, err := s.AskButtonsOf(ctx, "alpha", []int64{q.ID})
	require.NoError(t, err)
	for _, x := range after[q.ID] {
		assert.Equal(t, ButtonPending, x.State, "%s stays pending", x.Action)
	}
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[2].ID, time.Now())
	assert.NoError(t, err, "the reply is not blocked by the opens")
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[0].ID, time.Now())
	assert.NoError(t, err, "an open is usable even after the reply was claimed")
	require.NoError(t, s.CloseAsk(ctx, "alpha", q.ID, "Operator", "answered"))
	_, err = s.ClaimAskButton(ctx, "alpha", q.ID, b[0].ID, time.Now())
	assert.ErrorIs(t, err, ErrAskClosed)
}
