package board

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7364, the Hub's service-only per-machine read (the #7331 note, sections 6, 11 point 4 and 12): which tasks of this machine came from ONE goal request, asked about by request id and by who sent it. Only the
// task made by accepting that request, only for the asker (server and board) that sent it, never by goal uid, never for a request that is pending, declined or expired.
func acceptedRequest(t *testing.T, s *Store, ctx context.Context, from, to, title, assignee string) (reqID string, task *Task) {
	t.Helper()
	on := true
	_, err := s.UpdateBoardSettings(ctx, to, BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	g := newGoal(t, s, from, "Goal of "+from)
	_, in, err := s.SendGoalRequest(ctx, from, g.ID, to, "do it", "Lead", nil)
	require.NoError(t, err)
	task, _, err = s.AcceptGoalRequest(ctx, to, in.ID, title, "body", "high", "Orch", assignee)
	require.NoError(t, err)
	return in.RequestID, task
}

func TestGoalLinksAreTheTaskMadeByAcceptingThatRequestForThatAsker(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, task := acceptedRequest(t, s, ctx, "alpha", "beta", "Build the importer", "Dev B")
	rid2, task2 := acceptedRequest(t, s, ctx, "alpha", "beta", "A second job", "")

	reply, err := s.GoalLinks(ctx, rid, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Equal(t, rid, reply.RequestID)
	assert.Equal(t, 1, reply.AcceptedTotal)
	require.Len(t, reply.Accepted, 1, "one request, the one task made by accepting it")
	assert.Nil(t, reply.NextCursor)
	l := reply.Accepted[0]
	assert.Equal(t, task.ID, l.TaskID)
	assert.Equal(t, rid, l.RequestID)
	assert.Equal(t, "Build the importer", l.Title)
	assert.Equal(t, "pending", l.TaskStatus)
	assert.Equal(t, "accepted", l.RequestState)
	assert.Equal(t, "Dev B", l.Assignee)
	assert.Equal(t, "beta", l.Board)
	assert.NotEmpty(t, l.GoalUID)
	assert.Regexp(t, `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`, l.AcceptedAt)
	assert.Regexp(t, `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`, l.UpdatedAt)
	reply2, err := s.GoalLinks(ctx, rid2, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	require.Len(t, reply2.Accepted, 1)
	assert.Equal(t, task2.ID, reply2.Accepted[0].TaskID, "the other request's task is its own")

	// not the asker: another board, another server (this request was sent from this computer, so its server is empty)
	for _, c := range []struct{ server, board string }{{"", "gamma"}, {"srv-x", "alpha"}, {"srv-x", "gamma"}, {"", "ALPHA"}, {"", "alpha "}} {
		none, err := s.GoalLinks(ctx, rid, c.server, c.board, "", 50, nil)
		require.NoError(t, err, "%v", c)
		assert.Empty(t, none.Accepted, "asker %v sees nothing of another's request", c)
		assert.Zero(t, none.AcceptedTotal)
	}
	// an id nobody sent answers empty; an id that is not 32 lower-case hex digits is a bad query
	none, err := s.GoalLinks(ctx, strings.Repeat("0", 32), "", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Empty(t, none.Accepted)
	assert.Equal(t, `{"request_id":"`+strings.Repeat("0", 32)+`","accepted_requests":[],"accepted_requests_total":0,"next_cursor":null}`, string(func() []byte { b, err := json.Marshal(none); require.NoError(t, err); return b }()), "an empty answer is an empty list, never null")
	for _, id := range []string{"no-such-request", "", strings.ToUpper(rid), rid + "0", rid[:31]} {
		_, err := s.GoalLinks(ctx, id, "", "alpha", "", 50, nil)
		assert.ErrorIs(t, err, ErrBadGoalLinksQuery, "request id %q", id)
	}
	for _, limit := range []int{0, -1, GoalLinksMaxLimit + 1} {
		_, err := s.GoalLinks(ctx, rid, "", "alpha", "", limit, nil)
		assert.ErrorIs(t, err, ErrBadGoalLinksQuery, "limit %d", limit)
	}
}

func TestGoalLinksNeedAnAcceptedRequestAndNothingLabelledAnyOtherWay(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	on := true
	_, err := s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	g := newGoal(t, s, "alpha", "Goal")
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "do it", "Lead", nil)
	require.NoError(t, err)
	reply, err := s.GoalLinks(ctx, in.RequestID, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Empty(t, reply.Accepted, "pending")

	// a task B labelled with the goal's uid some other way (no request id) shows nothing, even for the right asker and an accepted request
	other, err := s.CreateTask(ctx, "beta", "labelled by hand", "", "medium", "Lead")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET remote_goal_uid = ? WHERE id = ?`, g.UID, other.ID)
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "The real one", "", "medium", "Orch", "")
	require.NoError(t, err)
	reply, err = s.GoalLinks(ctx, in.RequestID, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	require.Len(t, reply.Accepted, 1)
	assert.Equal(t, "The real one", reply.Accepted[0].Title, "by request id, never by goal uid")

	// declined and expired requests have no task
	_, in2, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "again", "Lead", nil)
	require.NoError(t, err)
	_, err = s.DeclineGoalRequest(ctx, "beta", in2.ID, "no", "Orch")
	require.NoError(t, err)
	none, err := s.GoalLinks(ctx, in2.RequestID, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Empty(t, none.Accepted)
	_, in3, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "late", "Lead", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = 'expired' WHERE id = ?`, in3.ID)
	require.NoError(t, err)
	none, err = s.GoalLinks(ctx, in3.RequestID, "", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Empty(t, none.Accepted)
}

func TestGoalLinksTitlesAreRedactedBoundedAndTheRowIsExactlyTheseFields(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, _ := acceptedRequest(t, s, ctx, "alpha", "beta", "Rotate key ghp"+"_abcdefghijklmnopqrstuvwxyz0123456789", "Dev")
	reply, err := s.GoalLinks(ctx, rid, "", "alpha", "", 50, func(s string) string {
		return strings.ReplaceAll(s, "ghp"+"_abcdefghijklmnopqrstuvwxyz0123456789", "[redacted]")
	})
	require.NoError(t, err)
	require.Len(t, reply.Accepted, 1)
	l := reply.Accepted[0]
	assert.Equal(t, "Rotate key [redacted]", l.Title)
	b, err := json.Marshal(l)
	require.NoError(t, err)
	assert.Equal(t, `{"request_id":"`+rid+`","board":"beta","goal_uid":"`+l.GoalUID+`","task_id":`+fmt.Sprint(l.TaskID)+`,"task_status":"pending","request_state":"accepted","accepted_at":"`+l.AcceptedAt+`","title":"Rotate key [redacted]","assignee":"Dev","updated_at":"`+l.UpdatedAt+`"}`, string(b), "the golden of a row; no body, no sender, no reason")

	// the two free-text fields are cut to their bound, before and after redaction
	rid2, task := acceptedRequest(t, s, ctx, "alpha", "beta", strings.Repeat("é", GoalLinksTitleMax+50), strings.Repeat("a", GoalLinksAssigneeMax+10))
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET assigned_to = ? WHERE id = ?`, strings.Repeat("a", GoalLinksAssigneeMax+10), task.ID)
	require.NoError(t, err)
	reply, err = s.GoalLinks(ctx, rid2, "", "alpha", "", 50, func(s string) string { return s + s })
	require.NoError(t, err)
	assert.Equal(t, GoalLinksTitleMax, len([]rune(reply.Accepted[0].Title)))
	assert.Equal(t, GoalLinksAssigneeMax, len([]rune(reply.Accepted[0].Assignee)))

	// four-byte characters are cut to the byte bound too, and a full page of the largest rows (a 128-byte board name, four-byte characters everywhere) is under the one reply cap
	wide := string([]rune(strings.Repeat("\U0001D4B3", 300)))
	assert.LessOrEqual(t, len(boundText(wide, GoalLinksTitleMax, GoalLinksTitleBytes)), GoalLinksTitleBytes)
	assert.True(t, utf8.ValidString(boundText(wide, GoalLinksTitleMax, GoalLinksTitleBytes)), "cut on a character boundary")
	row := GoalLinkRow{RequestID: strings.Repeat("f", 32), Board: strings.Repeat("b", 128), GoalUID: strings.Repeat("g", 36), TaskID: 1 << 40, TaskStatus: "in_progress", RequestState: "accepted",
		AcceptedAt: "2030-01-01T00:00:00Z", Title: boundText(wide, GoalLinksTitleMax, GoalLinksTitleBytes), Assignee: boundText(wide, GoalLinksAssigneeMax, GoalLinksAssigneeBytes), UpdatedAt: "2030-01-01T00:00:00Z"}
	one, err := json.Marshal(row)
	require.NoError(t, err)
	assert.Less(t, len(one)*GoalLinksMaxLimit, GoalLinksReplyMaxBytes, "100 rows of %d bytes", len(one))
}

// Paged: a limit (default 50, at most 100), stable order (accepted_at, task_id), a cursor bound to the request and the asker, each row once, an exact total. The unique indexes that make it one task per
// request are dropped here to have rows to page over; the paging does not depend on them.
func TestGoalLinksPageExactlyOnceInOrderAndTheCursorIsBoundToTheRequest(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, first := acceptedRequest(t, s, ctx, "alpha", "beta", "t0", "")
	rid2, _ := acceptedRequest(t, s, ctx, "alpha", "beta", "other", "")
	for _, q := range []string{`DROP INDEX idx_board_tasks_request_key`, `DROP INDEX idx_goal_requests_in_key`} {
		_, err := s.db.ExecContext(ctx, q)
		require.NoError(t, err)
	}
	ids := []int64{first.ID}
	for i := 1; i < 120; i++ {
		task, err := s.CreateTask(ctx, "beta", fmt.Sprintf("t%d", i), "", "medium", "Lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET request_id = ?, request_server = '', request_board = 'alpha' WHERE id = ?`, rid, task.ID)
		require.NoError(t, err)
		// ten accepted rows share each second, so the order within a second is the task id
		_, err = s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, status, task_id, created_at, answered_at)
			VALUES ('beta', ?, '', 'alpha', 'g', 'accepted', ?, '2026-01-01T00:00:00Z', ?)`, rid, task.ID, fmt.Sprintf("2030-01-01T00:00:%02dZ", 1+i/10))
		require.NoError(t, err)
		ids = append(ids, task.ID)
	}
	var got []int64
	cursor, pages := "", 0
	for {
		reply, err := s.GoalLinks(ctx, rid, "", "alpha", cursor, 50, nil)
		require.NoError(t, err)
		pages++
		assert.Equal(t, 120, reply.AcceptedTotal, "the total is exact on every page")
		for _, l := range reply.Accepted {
			got = append(got, l.TaskID)
		}
		if reply.NextCursor == nil {
			break
		}
		assert.Len(t, reply.Accepted, 50, "a full page when there is a next one")
		assert.LessOrEqual(t, len(*reply.NextCursor), GoalLinksMaxCursor)
		cursor = *reply.NextCursor
		require.Less(t, pages, 10)
	}
	assert.Equal(t, 3, pages, "50, 50 and 20")
	// the first request's own row was made at accept time (now), after the 2030 ones? no: before. Either way each row is once and the order is (accepted_at, task_id).
	assert.ElementsMatch(t, ids, got)
	seen := map[int64]bool{}
	for _, id := range got {
		assert.False(t, seen[id], "task %d once", id)
		seen[id] = true
	}

	// a limit smaller than the default pages by that many
	small, err := s.GoalLinks(ctx, rid, "", "alpha", "", 7, nil)
	require.NoError(t, err)
	assert.Len(t, small.Accepted, 7)
	require.NotNil(t, small.NextCursor)
	assert.Equal(t, got[:7], func() (o []int64) {
		for _, l := range small.Accepted {
			o = append(o, l.TaskID)
		}
		return
	}(), "the same order whatever the limit")

	// a cursor of one request is no good on another, for another asker, or when made up or too long
	for _, bad := range []struct{ id, server, board, cursor string }{
		{rid2, "", "alpha", *small.NextCursor}, {rid, "srv", "alpha", *small.NextCursor}, {rid, "", "alpha", "not-a-cursor"}, {rid, "", "alpha", strings.Repeat("A", GoalLinksMaxCursor+1)},
	} {
		_, err := s.GoalLinks(ctx, bad.id, bad.server, bad.board, bad.cursor, 50, nil)
		assert.ErrorIs(t, err, ErrBadGoalLinksQuery, "%+v", bad)
	}
}

// The receiving board's switch off: the Hub is told by name, but only for a request this asker really sent; for any other asker or an unknown id the answer is the same empty one as ever.
func TestGoalLinksSayGoalRequestsOffOnlyForTheAskersOwnRequest(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, _ := acceptedRequest(t, s, ctx, "alpha", "beta", "job", "")
	off := false
	_, err := s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{GoalRequests: &off})
	require.NoError(t, err)
	_, err = s.GoalLinks(ctx, rid, "", "alpha", "", 50, nil)
	assert.ErrorIs(t, err, ErrGoalRequestsOff)
	for _, c := range []struct{ id, server, board string }{{rid, "", "gamma"}, {rid, "srv-x", "alpha"}, {strings.Repeat("0", 32), "", "alpha"}} {
		reply, err := s.GoalLinks(ctx, c.id, c.server, c.board, "", 50, nil)
		require.NoError(t, err, "%+v", c)
		assert.Empty(t, reply.Accepted, "%+v: no oracle for a request that is not this asker's", c)
	}
}

// The state words are the closed lists of the frozen API (#7411); the tables' CHECK constraints say the same words.
func TestGoalRequestStateWordsAreTheClosedLists(t *testing.T) {
	assert.Equal(t, []string{"pending", "accepted", "declined", "expired"}, GoalRequestReceiverStates)
	assert.Equal(t, []string{"requested", "accepted", "declined", "expired"}, GoalRequestAskerStates)
	s := testStore(t)
	ctx := context.Background()
	for _, w := range []string{"pending", "accepted", "declined", "expired"} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_board, goal_uid, status, created_at) VALUES ('b', ?, 'a', 'g', ?, 'x')`, w+strings.Repeat("0", 32-len(w)), w)
		assert.NoError(t, err, w)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_board, goal_uid, status, created_at) VALUES ('b', 'zz', 'a', 'g', 'requested', 'x')`)
	assert.Error(t, err, "the receiver's table does not take the asker's word")
}

// #7411 (Security's MUST 2): the key of a request is (receiving board, sender server, sender board, request id), in the received rows and in the tasks made from them. Two senders that choose the same
// id, or two boards of one sender, each get their own row and their own task, and each is told only its own.
func TestTwoSendersWithOneRequestIDEachGetTheirOwnRowAndTask(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	on := true
	_, err := s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	rid := strings.Repeat("ab", 16)
	type sender struct{ server, board string }
	senders := []sender{{"srv-1", "alpha"}, {"srv-2", "alpha"}, {"srv-1", "gamma"}}
	titles := map[sender]string{}
	for i, sd := range senders {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, status, created_at) VALUES ('beta', ?, ?, ?, ?, 'pending', '2030-01-01T00:00:00Z')`,
			rid, sd.server, sd.board, fmt.Sprintf("goal-%d", i))
		require.NoError(t, err, "a second sender's row with the same id is not a conflict")
	}
	// the same sender and id again IS a conflict
	_, err = s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, status, created_at) VALUES ('beta', ?, 'srv-1', 'alpha', 'x', 'pending', 'x')`, rid)
	require.Error(t, err)
	for i, sd := range senders {
		var id int64
		require.NoError(t, s.db.GetContext(ctx, &id, `SELECT id FROM board_goal_requests_in WHERE from_server = ? AND from_board = ?`, sd.server, sd.board))
		titles[sd] = fmt.Sprintf("job for %s/%s", sd.server, sd.board)
		task, _, err := s.AcceptGoalRequest(ctx, "beta", id, titles[sd], "", "medium", "Orch", "")
		require.NoError(t, err, "sender %d", i)
		require.NotZero(t, task.ID)
	}
	for _, sd := range senders {
		reply, err := s.GoalLinks(ctx, rid, sd.server, sd.board, "", 50, nil)
		require.NoError(t, err)
		require.Len(t, reply.Accepted, 1, "%v sees one row: its own", sd)
		assert.Equal(t, titles[sd], reply.Accepted[0].Title, "%v sees its own task, not another sender's", sd)
	}
}

// #7464: the title is redacted whole and then cut, so a token that straddles the 200-character bound is replaced, never left as its front half.
func TestGoalLinksRedactBeforeTheyCut(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	token := "gh" + "p_" + strings.Repeat("Ab1", 12) // 38 characters: ghp_ and 36
	redact := func(in string) string {
		return regexp.MustCompile(`ghp_[A-Za-z0-9]{36}`).ReplaceAllString(in, "[redacted]")
	}
	for _, pad := range []int{150, 170, 185, 190, 195, 199, 200} {
		title := strings.Repeat("a", pad) + token
		rid, _ := acceptedRequest(t, s, ctx, "alpha", "beta", title, "Dev")
		reply, err := s.GoalLinks(ctx, rid, "", "alpha", "", 50, redact)
		require.NoError(t, err)
		require.Len(t, reply.Accepted, 1)
		got := reply.Accepted[0].Title
		assert.NotContains(t, got, "ghp_", "pad %d: no front of the token is left: %q", pad, got)
		assert.LessOrEqual(t, len([]rune(got)), GoalLinksTitleMax, "pad %d", pad)
	}
}

// #7464 pins (Security Reviewer Windows). Each fails on its mutant.

// The reconcile (a crash between the task and the mark leaves a task whose request is still pending) is keyed with the sender's server: two senders with the same sender board and the same id on one receiving
// board are not mixed up, and the other asker is shown nothing.
func TestReconcileMarksOnlyTheRequestOfTheSenderServerThatTheTaskIsFor(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	on := true
	_, err := s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	rid := strings.Repeat("cd", 16)
	for _, srv := range []string{"srv-1", "srv-2"} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_in (board_id, request_id, from_server, from_board, goal_uid, status, created_at) VALUES ('beta', ?, ?, 'alpha', 'g', 'pending', '2030-01-01T00:00:00Z')`, rid, srv)
		require.NoError(t, err)
	}
	// srv-1's task exists (made, then the crash: its row is still pending)
	task, err := s.CreateTaskWithOpts(ctx, "beta", "srv-1's job", "", "medium", "Lead", &CreateTaskOpts{remote: &remoteGoalLink{BoardUID: "b", GoalUID: "g", RequestID: rid, Server: "srv-1", Board: "alpha"}})
	require.NoError(t, err)
	rows, err := s.ListGoalRequestsIn(ctx, "beta", "", 50)
	require.NoError(t, err)
	got := map[string]string{}
	for _, r := range rows {
		got[r.FromServer] = r.Status
	}
	assert.Equal(t, map[string]string{"srv-1": "accepted", "srv-2": "pending"}, got, "only the sender the task was made for is marked")
	reply, err := s.GoalLinks(ctx, rid, "srv-2", "alpha", "", 50, nil)
	require.NoError(t, err)
	assert.Empty(t, reply.Accepted, "the other asker is shown nothing")
	reply, err = s.GoalLinks(ctx, rid, "srv-1", "alpha", "", 50, nil)
	require.NoError(t, err)
	require.Len(t, reply.Accepted, 1)
	assert.Equal(t, task.ID, reply.Accepted[0].TaskID)
}

// A reply is applied only for a request id of the one form (32 lower-case hex), even when a row with another id exists.
func TestAReplyWithAMalformedRequestIDIsNotApplied(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, id := range []string{strings.Repeat("AB", 16), strings.Repeat("ab", 15) + "a", strings.Repeat("ab", 16) + "a", strings.Repeat("ab", 15) + "a\x00", strings.Repeat("ab", 15) + "a\n", ""} {
		_, err := s.db.ExecContext(ctx, `INSERT INTO board_goal_requests_out (board_id, goal_id, request_id, to_server, to_board, status, created_at) VALUES ('alpha', 1, ?, '', 'beta', 'requested', '2030-01-01T00:00:00Z')`, id)
		require.NoError(t, err)
		_, err = s.ApplyGoalRequestReply(ctx, "alpha", id, "", "beta", "accepted", "")
		assert.ErrorIs(t, err, ErrGoalRequestReplyUnknown, "id %q", id)
		var status string
		require.NoError(t, s.db.GetContext(ctx, &status, `SELECT status FROM board_goal_requests_out WHERE request_id = ?`, id))
		assert.Equal(t, "requested", status, "the row is untouched: %q", id)
	}
}

// A received row is listed by the read only when it is accepted, even when it has a task id.
func TestGoalLinksListOnlyAcceptedRows(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, task := acceptedRequest(t, s, ctx, "alpha", "beta", "job", "")
	for _, st := range []string{"pending", "declined", "expired"} {
		_, err := s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = ? WHERE request_id = ?`, st, rid)
		require.NoError(t, err)
		reply, err := s.GoalLinks(ctx, rid, "", "alpha", "", 50, nil)
		require.NoError(t, err)
		assert.Empty(t, reply.Accepted, "a %s row that still has task %d is not listed", st, task.ID)
		assert.Zero(t, reply.AcceptedTotal, st)
	}
}
