package board

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func requestEnv(t *testing.T) (*Store, context.Context, *Goal) {
	t.Helper()
	s := testStore(t)
	return s, context.Background(), newGoal(t, s, "alpha", "Ship the beta")
}

// A request makes both rows in one step; the asker's row holds no text, the receiver's holds the typed request.
func TestSendGoalRequestMakesBothRows(t *testing.T) {
	s, ctx, g := requestEnv(t)
	out, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "  Please build the importer\x00  ", "Lead")
	require.NoError(t, err)
	assert.Equal(t, GoalRequestRequested, out.Status)
	assert.Equal(t, "beta", out.ToBoard)
	assert.Equal(t, out.RequestID, in.RequestID)
	assert.Equal(t, GoalRequestPending, in.Status)
	assert.Equal(t, "beta", in.BoardID)
	assert.Equal(t, "alpha", in.FromBoard)
	assert.Equal(t, g.UID, in.GoalUID)
	assert.Equal(t, "Ship the beta", in.GoalTitle)
	assert.Equal(t, "Please build the importer", in.Ask, "text is cleaned")

	// the asker's row has nowhere to hold the other team's work
	cols, err := s.db.QueryxContext(ctx, `SELECT * FROM board_goal_requests_out LIMIT 1`)
	require.NoError(t, err)
	names, _ := cols.Columns()
	cols.Close()
	for _, n := range names {
		assert.NotContains(t, n, "task", "no task column on the asker's side")
		assert.NotContains(t, n, "count")
		assert.NotContains(t, n, "title")
	}
}

func TestSendGoalRequestRefusals(t *testing.T) {
	s, ctx, g := requestEnv(t)
	_, _, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "   ", "Lead")
	assert.ErrorIs(t, err, ErrGoalRequestAskRequired)
	_, _, err = s.SendGoalRequest(ctx, "alpha", g.ID, "beta", strings.Repeat("x", GoalRequestAskMax+1), "Lead")
	assert.Equal(t, "text_too_long", err.(*GoalRequestError).Code)
	_, _, err = s.SendGoalRequest(ctx, "alpha", 99999, "beta", "x", "Lead")
	assert.Error(t, err, "a goal that is not there")
	other := newGoal(t, s, "gamma", "Another board's")
	_, _, err = s.SendGoalRequest(ctx, "alpha", other.ID, "beta", "x", "Lead")
	assert.Error(t, err, "another board's goal cannot be asked about")
	_, _, err = s.CloseGoal(ctx, "alpha", g.ID, "all done", GoalDone)
	require.NoError(t, err)
	_, _, err = s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
	assert.ErrorIs(t, err, ErrGoalClosed, "a closed goal asks for nothing")
}

func TestGoalRequestCaps(t *testing.T) {
	s, ctx, _ := requestEnv(t)
	for i := 0; i < GoalRequestPendingPerPair; i++ {
		g := newGoal(t, s, "alpha", fmt.Sprintf("goal %d", i))
		_, _, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
		require.NoError(t, err, i)
	}
	g := newGoal(t, s, "alpha", "one too many")
	_, _, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
	assert.ErrorIs(t, err, ErrGoalRequestTooManyTotal, "20 waiting from one board")
	// another sender board still gets in, up to the target's total of 100
	for b := 0; b < 4; b++ {
		from := fmt.Sprintf("from%d", b)
		for i := 0; i < GoalRequestPendingPerPair; i++ {
			g := newGoal(t, s, from, fmt.Sprintf("g%d", i))
			_, _, err := s.SendGoalRequest(ctx, from, g.ID, "beta", "x", "Lead")
			require.NoError(t, err, "%s %d", from, i)
		}
	}
	g = newGoal(t, s, "late", "late")
	_, _, err = s.SendGoalRequest(ctx, "late", g.ID, "beta", "x", "Lead")
	assert.ErrorIs(t, err, ErrGoalRequestTooManyTotal, "100 waiting on the target in all")
	// an answered request frees its place
	list, err := s.ListGoalRequestsIn(ctx, "beta", GoalRequestPending, 200)
	require.NoError(t, err)
	_, err = s.DeclineGoalRequest(ctx, "beta", list[0].ID, "no", "Lead")
	require.NoError(t, err)
	_, _, err = s.SendGoalRequest(ctx, "late", g.ID, "beta", "x", "Lead")
	assert.NoError(t, err)
}

// Accept: one transaction's worth, one task per request, linked to the asker's goal, never copying the ask.
func TestAcceptGoalRequestCreatesALinkedTaskOnce(t *testing.T) {
	s, ctx, g := requestEnv(t)
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "SECRET-ASK-TEXT build it", "Lead")
	require.NoError(t, err)

	task, after, err := s.AcceptGoalRequest(ctx, "beta", in.ID, "Build the importer", "my own body", "high", "Orch B", "Dev B")
	require.NoError(t, err)
	assert.Equal(t, GoalRequestAccepted, after.Status)
	require.NotNil(t, after.TaskID)
	assert.Equal(t, task.ID, *after.TaskID)
	assert.Equal(t, "Orch B", after.DecidedBy)
	assert.Equal(t, "Build the importer", task.Title)
	body := ""
	if task.Body != nil {
		body = *task.Body
	}
	assert.NotContains(t, task.Title+body, "SECRET-ASK-TEXT", "the ask is never copied into the task")

	var link struct {
		Board, Goal, Request *string
		GoalID               *int64
	}
	require.NoError(t, s.db.QueryRowxContext(ctx, `SELECT remote_board_uid, remote_goal_uid, request_id, goal_id FROM board_tasks WHERE id = ?`, task.ID).Scan(&link.Board, &link.Goal, &link.Request, &link.GoalID))
	require.NotNil(t, link.Goal)
	assert.Equal(t, g.UID, *link.Goal)
	assert.Equal(t, in.RequestID, *link.Request)
	assert.Nil(t, link.GoalID, "a task has a local goal or a remote one, never both")

	// a second accept, and a decline after it, are refused and make nothing
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "Again", "", "medium", "Orch B", "")
	assert.ErrorIs(t, err, ErrGoalRequestAnswered)
	_, err = s.DeclineGoalRequest(ctx, "beta", in.ID, "late", "Orch B")
	assert.ErrorIs(t, err, ErrGoalRequestAnswered)
	var n int
	require.NoError(t, s.db.QueryRowxContext(ctx, `SELECT COUNT(*) FROM board_tasks WHERE request_id = ?`, in.RequestID).Scan(&n))
	assert.Equal(t, 1, n)

}

// A board that requires a goal takes a task made for another team's request: it has that team's goal.
func TestAcceptOnABoardThatRequiresAGoal(t *testing.T) {
	s, ctx, g := requestEnv(t)
	on := true
	_, err := s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{RequireGoal: &on})
	require.NoError(t, err)
	_, err = s.CreateTask(ctx, "beta", "plain", "", "medium", "Lead")
	require.ErrorIs(t, err, ErrGoalRequired, "a task with no goal is refused there")
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "For their goal", "", "medium", "Orch B", "")
	assert.NoError(t, err)
}

func TestAcceptRefusedForDeclinedExpiredAndOtherBoards(t *testing.T) {
	s, ctx, g := requestEnv(t)
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "gamma", in.ID, "t", "", "medium", "Orch", "")
	assert.ErrorIs(t, err, ErrGoalRequestNotFound, "another board's request is not there")
	_, err = s.DeclineGoalRequest(ctx, "beta", in.ID, "not now", "Orch B")
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "t", "", "medium", "Orch B", "")
	assert.ErrorIs(t, err, ErrGoalRequestAnswered, "declined stays declined")

	g2 := newGoal(t, s, "alpha", "second")
	_, in2, err := s.SendGoalRequest(ctx, "alpha", g2.ID, "beta", "x", "Lead")
	require.NoError(t, err)
	old := time.Now().UTC().Add(-GoalRequestTTL - time.Hour).Format(time.RFC3339)
	_, err = s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET created_at = ? WHERE id = ?`, old, in2.ID)
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in2.ID, "t", "", "medium", "Orch B", "")
	assert.ErrorIs(t, err, ErrGoalRequestExpired, "after 14 days")
	_, err = s.DeclineGoalRequest(ctx, "beta", in2.ID, "", "Orch B")
	assert.ErrorIs(t, err, ErrGoalRequestExpired)
}

// The reply: only for a request this board made, from the target it addressed, once; an accept carries no text.
func TestApplyGoalRequestReply(t *testing.T) {
	s, ctx, g := requestEnv(t)
	out, _, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "x", "Lead")
	require.NoError(t, err)

	_, err = s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "", "gamma", GoalRequestAccepted, "")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "from a board the request was not sent to")
	_, err = s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "other-server", "beta", GoalRequestAccepted, "")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "from another server")
	_, err = s.ApplyGoalRequestReply(ctx, "alpha", "no-such-id", "", "beta", GoalRequestAccepted, "")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown)
	_, err = s.ApplyGoalRequestReply(ctx, "gamma", out.RequestID, "", "beta", GoalRequestAccepted, "")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "a reply for a request of another board")
	_, err = s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "", "beta", "maybe", "")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "only accepted or declined")

	done, err := s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "", "beta", GoalRequestAccepted, "ignored text")
	require.NoError(t, err)
	assert.Equal(t, GoalRequestAccepted, done.Status)
	assert.Empty(t, done.Reason, "an accept carries no text")
	_, err = s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "", "beta", GoalRequestDeclined, "changed my mind")
	assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "the first reply wins")
	again, err := s.GoalRequestsOut(ctx, "alpha", g.ID, 10)
	require.NoError(t, err)
	assert.Equal(t, GoalRequestAccepted, again[0].Status)

	g2 := newGoal(t, s, "alpha", "two")
	out2, _, err := s.SendGoalRequest(ctx, "alpha", g2.ID, "beta", "x", "Lead")
	require.NoError(t, err)
	d, err := s.ApplyGoalRequestReply(ctx, "alpha", out2.RequestID, "", "beta", GoalRequestDeclined, strings.Repeat("r", GoalRequestReasonMax))
	require.NoError(t, err)
	assert.Len(t, d.Reason, GoalRequestReasonMax)
	g3 := newGoal(t, s, "alpha", "three")
	out3, _, _ := s.SendGoalRequest(ctx, "alpha", g3.ID, "beta", "x", "Lead")
	_, err = s.ApplyGoalRequestReply(ctx, "alpha", out3.RequestID, "", "beta", GoalRequestDeclined, strings.Repeat("r", GoalRequestReasonMax+1))
	assert.Error(t, err, "a reason over 500 is refused")
}

// accepted_requests: the ids and targets a goal addressed, capped, with the total; the goal counter moves with each change.
func TestAcceptedGoalRequestsAndTheGoalCounter(t *testing.T) {
	s, ctx, g := requestEnv(t)
	seq := func() int64 {
		var n int64
		_ = s.db.QueryRowxContext(ctx, `SELECT COALESCE((SELECT seq FROM board_goal_meta WHERE board_id = 'alpha'), 0)`).Scan(&n)
		return n
	}
	before := seq()
	var first string
	for i := 0; i < GoalRequestAcceptedListMax+3; i++ {
		to := fmt.Sprintf("team%d", i)
		out, _, err := s.SendGoalRequest(ctx, "alpha", g.ID, to, "x", "Lead")
		if err != nil { // 20 waiting from one board: answer as we go
			t.Fatal(err)
		}
		if i == 0 {
			first = out.RequestID
		}
		mid := seq()
		_, err = s.ApplyGoalRequestReply(ctx, "alpha", out.RequestID, "", to, GoalRequestAccepted, "")
		require.NoError(t, err)
		assert.Greater(t, seq(), mid, "an answer moves the goal counter")
	}
	assert.Greater(t, seq(), before, "a request moves it")
	refs, total, err := s.AcceptedGoalRequests(ctx, "alpha", g.ID)
	require.NoError(t, err)
	assert.Equal(t, GoalRequestAcceptedListMax+3, total)
	assert.Len(t, refs, GoalRequestAcceptedListMax)
	assert.NotEqual(t, first, refs[0].RequestID, "newest first")
	assert.Equal(t, "team22", refs[0].Board)
	other, tot, err := s.AcceptedGoalRequests(ctx, "alpha", g.ID+1000)
	require.NoError(t, err)
	assert.Empty(t, other)
	assert.Zero(t, tot)
}

// The request key is per sender: one sender cannot suppress another's request by choosing its id.
func TestGoalRequestIDIsKeyedPerSender(t *testing.T) {
	s, ctx, _ := requestEnv(t)
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, created_at) VALUES ('beta', 'same', 'srv-a', 'x', 'u', ?)`, nowUTC())
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, created_at) VALUES ('beta', 'same', 'srv-b', 'x', 'u', ?)`, nowUTC())
	assert.NoError(t, err, "another server may use the same id")
	_, err = s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, created_at) VALUES ('beta', 'same', 'srv-a', 'x', 'u', ?)`, nowUTC())
	assert.Error(t, err, "the same server cannot repeat one")
}

// The schema is made again without harm.
func TestGoalRequestsSchemaIsIdempotent(t *testing.T) {
	s, ctx, _ := requestEnv(t)
	require.NoError(t, s.ensureGoalRequestsSchema(ctx))
	require.NoError(t, s.ensureGoalRequestsSchema(ctx))
}
