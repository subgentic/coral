package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #11825: an active goal whose tasks are all done is ONE item of what waits for the Operator, "Goal #N looks done: <title>", kind goal_done, counted once, gone when the goal closes. Not yet (kept with the
// all-done total it was pressed at) hides it until a task is added; Ignore hides it for good. The saved list is goal_done_hidden, read on every request.
func TestNeedsYouHasOneItemForAGoalWhoseTasksAreAllDone(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil) // a board is listed once it has something on it
	require.NoError(t, err0)
	hidden := []string{}
	h.SetGoalDoneHidden(func(context.Context) []string { return hidden })
	h.goalDoneNow = quietPassed // the 15 quiet minutes after the last task are over (#12161)
	goal := func(title string, in board.GoalInput) *board.Goal {
		in.Title, in.CreatedBy = title, "Lead"
		g, err := bs.CreateGoal(ctx, "team", in)
		require.NoError(t, err)
		return g
	}
	task := func(g *board.Goal, finish bool) *board.Task {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		if finish {
			_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
			require.NoError(t, err)
			_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
			require.NoError(t, err)
		}
		return tk
	}
	read := func() []map[string]any {
		code, out := readNeedsYou(t, h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		var got []map[string]any
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_done" {
				got = append(got, it)
			}
		}
		assert.EqualValues(t, len(got), out["counts"].(map[string]any)["goal_done"], "counted once each")
		assert.EqualValues(t, len(got), out["count"], "and in the one count")
		return got
	}

	done := goal("Ship the export", board.GoalInput{DoneWhen: "the export runs"})
	task(done, true)
	task(done, true)
	open := goal("Still going", board.GoalInput{})
	task(open, true)
	task(open, false)
	goal("No tasks yet", board.GoalInput{})
	blocked := goal("Blocked one", board.GoalInput{})
	task(blocked, true)
	_, err := bs.UpdateGoal(ctx, "team", blocked.ID, board.GoalUpdate{State: ptrString(board.GoalBlocked), BlockedOn: ptrString("waiting on a vendor")})
	require.NoError(t, err)

	items := read()
	require.Len(t, items, 1, "only the goal whose tasks are all done: not one with an open task, none, or a blocked goal")
	assert.Equal(t, fmt.Sprintf("Goal #%d looks done: Ship the export", done.ID), items[0]["line"])
	assert.Equal(t, fmt.Sprintf("goal_done:team:%d", done.ID), items[0]["id"])
	assert.Equal(t, "team", items[0]["team"])
	assert.NotEmpty(t, items[0]["at"])

	hidden = []string{fmt.Sprintf("team|%d|2", done.ID)}
	assert.Empty(t, read(), "Not yet hides it at the total it was pressed at")
	added := task(done, false)
	assert.Empty(t, read(), "a goal with an open task is not done")
	_, err = bs.ClaimTask(ctx, "team", "Dev", added.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", added.ID, "Dev", nil)
	require.NoError(t, err)
	require.Len(t, read(), 1, "a task was added since Not yet (the total is 3, it was pressed at 2): the item is back")
	hidden = []string{fmt.Sprintf("team|%d|3", done.ID)}
	assert.Empty(t, read(), "and Not yet at the new total hides it again")
	hidden = []string{fmt.Sprintf("team|%d|*", done.ID)}
	assert.Empty(t, read(), "Ignore hides it whatever the total")
	hidden = []string{fmt.Sprintf("team|%d|3 ", done.ID), fmt.Sprintf("other|%d|*", done.ID)}
	assert.Len(t, read(), 1, "an entry that is not exactly the key, or is another team's, hides nothing")
	hidden = nil
	_, _, err = bs.CloseGoal(ctx, "team", done.ID, "all true", board.GoalDone)
	require.NoError(t, err)
	assert.Empty(t, read(), "gone when the goal closes")
}

// #11983 (the Operator): a "Goal looks done" item the Operator has opened is read, as a file is: it is not counted, so the count, the tab badge, the phone push and /api/needs-you say one number. The saved list is
// goal_done_read, "<team>|<goal>|<tasks>|<updated_at>" (the all-done total and the goal's last change it was opened at); a goal that gets another task done has a new total, and one that is reopened or edited has a new
// last change (#12006), so either way it is unread again.
func TestAGoalDoneItemTheOperatorOpenedIsNotCounted(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err0)
	var readList, hidden []string
	h.SetGoalDoneHidden(func(context.Context) []string { return hidden })
	h.goalDoneNow = quietPassed
	h.SetGoalDoneRead(func(context.Context) []string { return readList })
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the export", CreatedBy: "Lead"})
	require.NoError(t, err)
	finish := func() {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
		require.NoError(t, err)
		_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
		require.NoError(t, err)
	}
	key := func() string { // the entry the page writes for the goal as it is now
		cur, err := bs.GetGoal(ctx, "team", g.ID)
		require.NoError(t, err)
		return fmt.Sprintf("team|%d|%d|%s", cur.ID, cur.Rollup.Total, cur.UpdatedAt)
	}
	count := func() (int, int) {
		code, out := readNeedsYou(t, h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		goals := 0
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_done" {
				goals++
			}
		}
		assert.EqualValues(t, goals, out["counts"].(map[string]any)["goal_done"])
		return goals, int(out["count"].(float64))
	}
	finish()
	finish()
	n, all := count()
	assert.Equal(t, 1, n)
	assert.Equal(t, 1, all)

	readList = []string{key()}
	n, all = count()
	assert.Zero(t, n, "opened at its total and last change: read, not counted")
	assert.Zero(t, all, "and not in the one count")

	finish() // another task done: the goal's state changed again
	n, all = count()
	assert.Equal(t, 1, n, "a goal whose state changes again is unread again")
	assert.Equal(t, 1, all)

	cur := key()
	parts := strings.Split(cur, "|")
	with := func(i int, v string) string {
		p := append([]string(nil), parts...)
		p[i] = v
		return strings.Join(p, "|")
	}
	for name, entry := range map[string]string{"another team's": with(0, "other"), "another goal's": with(1, fmt.Sprint(g.ID+1)), "another total": with(2, "2"), "another last change": with(3, "2020-01-01T00:00:00Z"), "the old three-part form": strings.Join(parts[:3], "|"), "not exactly the key": cur + " ", "an Ignore star is not a read": fmt.Sprintf("team|%d|*", g.ID)} {
		readList = []string{entry}
		n, _ = count()
		if name == "an Ignore star is not a read" {
			assert.Equal(t, 1, n, name)
		} else {
			assert.Equal(t, 1, n, "an entry that is %s marks nothing read", name)
		}
	}
	readList = []string{key()}
	n, _ = count()
	assert.Zero(t, n)

	// #12006: closed and reopened, finished with the SAME total: the goal's last change is new, so it is unread again
	_, _, err = bs.CloseGoal(ctx, "team", g.ID, "all true", board.GoalDone)
	require.NoError(t, err)
	n, _ = count()
	assert.Zero(t, n, "closed: not an item")
	time.Sleep(1100 * time.Millisecond) // sleep-ok: updated_at has a resolution of a second
	_, err = bs.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{State: ptrString(board.GoalActive)})
	require.NoError(t, err)
	n, _ = count()
	assert.Equal(t, 1, n, "reopened with the same total: unread again, as its last change is new")
	readList = []string{key()}
	n, _ = count()
	assert.Zero(t, n, "and opened again, it is read")

	hidden = []string{fmt.Sprintf("team|%d|*", g.ID)}
	readList = nil
	n, _ = count()
	assert.Zero(t, n, "Ignore still hides it, read or not")
}

// #12073 (the Orchestrator: let the read check pass a goal with new_comments through, as the file rule does): a goal item the Operator opened (read, not counted) is counted again while agents have replied in the
// Operator's thread on it and they have not opened it; opened again, the news is seen and it is read once more.
func TestAReadGoalDoneItemCountsAgainWhileItsThreadHasNews(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err0)
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the export", CreatedBy: "Lead"})
	require.NoError(t, err)
	tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(t, err)
	cur, err := bs.GetGoal(ctx, "team", g.ID)
	require.NoError(t, err)
	readList := []string{fmt.Sprintf("team|%d|%d|%s", cur.ID, cur.Rollup.Total, cur.UpdatedAt)}
	news := map[string]int{}
	h.SetGoalDoneRead(func(context.Context) []string { return readList })
	h.goalDoneNow = quietPassed
	h.SetCommentNews(func(context.Context) (map[string]int, error) { return news, nil })
	items := func() []map[string]any {
		req := asPerson(httptest.NewRequest(http.MethodGet, "/api/needs-you", nil))
		w := httptest.NewRecorder()
		h.NeedsYou(w, req)
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		var got []map[string]any
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_done" {
				got = append(got, it)
			}
		}
		return got
	}
	assert.Empty(t, items(), "opened: read, not counted")
	news[goalSubject("team", g.ID)] = 1
	got := items()
	require.Len(t, got, 1, "an agent replied in the Operator's thread on the goal: it counts again, once")
	assert.EqualValues(t, 1, got[0]["new_comments"])
	assert.Equal(t, fmt.Sprintf("goal_done:team:%d", g.ID), got[0]["id"], "the same row")
	delete(news, goalSubject("team", g.ID)) // the Operator opened the thread
	assert.Empty(t, items(), "read once more")
}

// quietPassed is the clock of a test that does not care about the quiet period: well after any task it made.
func quietPassed() time.Time { return time.Now().Add(time.Hour) }

// #12161 (the Operator: "perhaps just a 15 minute period after the most recent task is completed, before sending it to my inbox"): a goal whose tasks are all done is a "Goal looks done" item of Needs you only once
// the latest task completion is at least 15 minutes old: a goal whose exploration is done but whose next tasks are not filed yet is not put in front of the Operator at once. A task added in the window cancels it
// (the goal has an open task), and finishing that one starts the quiet period again from its completion.
func TestAGoalLooksDoneToTheOperatorOnlyAfterFifteenQuietMinutes(t *testing.T) {
	h, bs := operatorAsksRig(t)
	ctx := context.Background()
	_, err0 := bs.PostMessage(ctx, "team", "Lead", "hello", nil)
	require.NoError(t, err0)
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Explore the options", CreatedBy: "Lead"})
	require.NoError(t, err)
	finish := func() {
		tk, err := bs.CreateTaskWithOpts(ctx, "team", "t", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
		require.NoError(t, err)
		_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
		require.NoError(t, err)
		_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
		require.NoError(t, err)
	}
	later := func(d time.Duration) { h.goalDoneNow = func() time.Time { return time.Now().Add(d) } }
	count := func() int {
		code, out := readNeedsYou(t, h, "", asPerson)
		require.Equal(t, http.StatusOK, code, out)
		n := 0
		for _, it := range needsYouItems(out) {
			if it["kind"] == "goal_done" {
				n++
			}
		}
		assert.EqualValues(t, n, out["counts"].(map[string]any)["goal_done"], "counted once each")
		return n
	}

	finish() // every task done, now
	later(0)
	assert.Zero(t, count(), "just finished: the driver has the first minutes")
	later(14 * time.Minute)
	assert.Zero(t, count(), "14 minutes after the last task: still not the Operator's")
	later(16 * time.Minute)
	assert.Equal(t, 1, count(), "16 minutes after the last task: the item")

	// a task added in the window cancels it; finishing it starts the quiet period again from its completion
	tk, err := bs.CreateTaskWithOpts(ctx, "team", "next", "", "medium", "Lead", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	later(16 * time.Minute)
	assert.Zero(t, count(), "a task was added: the goal has an open task")
	_, err = bs.ClaimTask(ctx, "team", "Dev", tk.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "team", tk.ID, "Dev", nil)
	require.NoError(t, err)
	later(14 * time.Minute)
	assert.Zero(t, count(), "its completion starts the 15 minutes again")
	later(16 * time.Minute)
	assert.Equal(t, 1, count())

	// the period is the Operator's setting (goal_done_quiet_minutes): none, or longer
	h.SetGoalDoneQuiet(func(context.Context) time.Duration { return 0 })
	later(0)
	assert.Equal(t, 1, count(), "0 minutes: at once")
	h.SetGoalDoneQuiet(func(context.Context) time.Duration { return 30 * time.Minute })
	later(20 * time.Minute)
	assert.Zero(t, count(), "30 minutes: not yet at 20")
	later(31 * time.Minute)
	assert.Equal(t, 1, count())
	assert.Equal(t, 30*time.Minute, GoalDoneQuietFrom(map[string]string{"goal_done_quiet_minutes": "30"}))
	assert.Equal(t, 15*time.Minute, GoalDoneQuietFrom(map[string]string{}), "unset: 15")
}
