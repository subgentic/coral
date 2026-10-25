package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7364, the Hub's service-only per-machine read (the #7331 note, sections 6, 11 point 4 and 12): which tasks of this machine came from ONE goal request, asked about by request id and by who sent it. Only the
// task made by accepting that request, only for the asker (server and board) that sent it, never by goal uid, never for a request that is pending, declined or expired.
func acceptedRequest(t *testing.T, s *Store, ctx context.Context, from, to, title, assignee string) (reqID string, task *Task) {
	t.Helper()
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

	page, err := s.GoalLinks(ctx, rid, "", "alpha", "", nil)
	require.NoError(t, err)
	require.Len(t, page.Links, 1, "one request, the one task made by accepting it")
	l := page.Links[0]
	assert.Equal(t, task.ID, l.ID)
	assert.Equal(t, "Build the importer", l.Title)
	assert.Equal(t, "pending", l.State)
	assert.Equal(t, "Dev B", l.Assignee)
	assert.NotEmpty(t, l.UpdatedAt)
	assert.Equal(t, "beta", l.Board)
	assert.Empty(t, page.Next)
	page2, err := s.GoalLinks(ctx, rid2, "", "alpha", "", nil)
	require.NoError(t, err)
	require.Len(t, page2.Links, 1)
	assert.Equal(t, task2.ID, page2.Links[0].ID, "the other request's task is its own")

	// not the asker: another board, another server (this request was sent from this computer, so its server is empty)
	for _, c := range []struct{ server, board string }{{"", "gamma"}, {"srv-x", "alpha"}, {"srv-x", "gamma"}, {"", "ALPHA"}, {"", "alpha "}} {
		none, err := s.GoalLinks(ctx, rid, c.server, c.board, "", nil)
		require.NoError(t, err, "%v", c)
		assert.Empty(t, none.Links, "asker %v sees nothing of another's request", c)
	}
	// an id nobody sent, an empty id, a wrong-case id
	for _, id := range []string{"no-such-request", "", strings.ToUpper(rid)} {
		none, err := s.GoalLinks(ctx, id, "", "alpha", "", nil)
		require.NoError(t, err)
		assert.Empty(t, none.Links, "request id %q", id)
	}
}

func TestGoalLinksNeedAnAcceptedRequestAndNothingLabelledAnyOtherWay(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	g := newGoal(t, s, "alpha", "Goal")
	_, in, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "do it", "Lead", nil)
	require.NoError(t, err)
	page, err := s.GoalLinks(ctx, in.RequestID, "", "alpha", "", nil)
	require.NoError(t, err)
	assert.Empty(t, page.Links, "pending")

	// a task B labelled with the goal's uid some other way (no request id) shows nothing, even for the right asker and an accepted request
	other, err := s.CreateTask(ctx, "beta", "labelled by hand", "", "medium", "Lead")
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET remote_goal_uid = ? WHERE id = ?`, g.UID, other.ID)
	require.NoError(t, err)
	_, _, err = s.AcceptGoalRequest(ctx, "beta", in.ID, "The real one", "", "medium", "Orch", "")
	require.NoError(t, err)
	page, err = s.GoalLinks(ctx, in.RequestID, "", "alpha", "", nil)
	require.NoError(t, err)
	require.Len(t, page.Links, 1)
	assert.Equal(t, "The real one", page.Links[0].Title, "by request id, never by goal uid")

	// declined and expired requests have no task
	_, in2, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "again", "Lead", nil)
	require.NoError(t, err)
	_, err = s.DeclineGoalRequest(ctx, "beta", in2.ID, "no", "Orch")
	require.NoError(t, err)
	none, err := s.GoalLinks(ctx, in2.RequestID, "", "alpha", "", nil)
	require.NoError(t, err)
	assert.Empty(t, none.Links)
	_, in3, err := s.SendGoalRequest(ctx, "alpha", g.ID, "beta", "late", "Lead", nil)
	require.NoError(t, err)
	_, err = s.db.ExecContext(ctx, `UPDATE board_goal_requests_in SET status = 'expired' WHERE id = ?`, in3.ID)
	require.NoError(t, err)
	none, err = s.GoalLinks(ctx, in3.RequestID, "", "alpha", "", nil)
	require.NoError(t, err)
	assert.Empty(t, none.Links)
}

func TestGoalLinksTitlesAreRedactedAndTheRowIsExactlySixFields(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, _ := acceptedRequest(t, s, ctx, "alpha", "beta", "Rotate key ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", "Dev")
	page, err := s.GoalLinks(ctx, rid, "", "alpha", "", func(s string) string {
		return strings.ReplaceAll(s, "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789", "[redacted]")
	})
	require.NoError(t, err)
	require.Len(t, page.Links, 1)
	assert.Equal(t, "Rotate key [redacted]", page.Links[0].Title)
	assert.Equal(t, `{"id":`+fmt.Sprint(page.Links[0].ID)+`,"title":"Rotate key [redacted]","state":"pending","assignee":"Dev","updated_at":"`+page.Links[0].UpdatedAt+`","board":"beta"}`, string(func() []byte { b, err := json.Marshal(page.Links[0]); require.NoError(t, err); return b }()), "the golden: id, title, state, assignee, updated_at, board; no body, no goal, no request id")
}

// Paged: 50 a page, a cursor bound to the request, each row once. The unique index that makes it one task per request is dropped here to have rows to page over; the cursor logic does not depend on it.
func TestGoalLinksPageExactlyOnceAndTheCursorIsBoundToTheRequest(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	rid, first := acceptedRequest(t, s, ctx, "alpha", "beta", "t0", "")
	rid2, _ := acceptedRequest(t, s, ctx, "alpha", "beta", "other", "")
	_, err := s.db.ExecContext(ctx, `DROP INDEX idx_board_tasks_request`)
	require.NoError(t, err)
	for i := 1; i < 120; i++ {
		task, err := s.CreateTask(ctx, "beta", fmt.Sprintf("t%d", i), "", "medium", "Lead")
		require.NoError(t, err)
		_, err = s.db.ExecContext(ctx, `UPDATE board_tasks SET request_id = ? WHERE id = ?`, rid, task.ID)
		require.NoError(t, err)
	}
	seen := map[int64]int{}
	cursor, pages := "", 0
	for {
		page, err := s.GoalLinks(ctx, rid, "", "alpha", cursor, nil)
		require.NoError(t, err)
		pages++
		assert.LessOrEqual(t, len(page.Links), GoalLinksPageSize)
		for _, l := range page.Links {
			seen[l.ID]++
		}
		if page.Next == "" {
			break
		}
		assert.Len(t, page.Links, GoalLinksPageSize, "a full page when there is a next one")
		cursor = page.Next
		require.Less(t, pages, 10)
	}
	assert.Equal(t, 3, pages, "50, 50 and 20")
	assert.Len(t, seen, 120)
	for id, n := range seen {
		assert.Equal(t, 1, n, "task %d once", id)
	}
	assert.Contains(t, seen, first.ID)
	assert.Equal(t, 50, GoalLinksPageSize)

	// a cursor of one request is no good on another, for another asker, or when made up
	page, err := s.GoalLinks(ctx, rid, "", "alpha", "", nil)
	require.NoError(t, err)
	require.NotEmpty(t, page.Next)
	for _, bad := range []struct{ id, server, board, cursor string }{
		{rid2, "", "alpha", page.Next}, {rid, "srv", "alpha", page.Next}, {rid, "", "alpha", "not-a-cursor"},
	} {
		_, err := s.GoalLinks(ctx, bad.id, bad.server, bad.board, bad.cursor, nil)
		assert.ErrorIs(t, err, ErrBadGoalLinksQuery, "%+v", bad)
	}
}
