package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #17206: GET /api/analytics/tasks over real stores. The Operator's question is "how many tasks is each agent completing": a cancelled task is not one, a review task is left out unless asked for,
// Failed is the part of Completed whose outcome failed, the total is the board's own completed count for the window, and the last bucket takes a task that finished just now.
type tasksEnv struct {
	srv       *httptest.Server
	now       time.Time
	boardPath string
	t         *testing.T
	h         *TasksAnalyticsHandler
}

func newTasksEnv(t *testing.T) *tasksEnv {
	t.Helper()
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	boardPath := filepath.Join(t.TempDir(), "board.db")
	bs, err := boardtest.Open(boardPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	now := time.Date(2026, 11, 15, 12, 30, 0, 0, time.UTC)
	h := NewTasksAnalyticsHandler(db, bs)
	h.now = func() time.Time { return now }
	ss := store.NewSessionStore(db)
	for _, s := range []struct{ id, typ, name string }{{effSessA, "claude", "Alpha Dev"}, {effSessB, "codex", "Beta Dev"}} {
		board := "alpha"
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: s.id, AgentName: s.name, AgentType: s.typ, WorkingDir: "/w", BoardName: &board}))
	}
	for _, m := range []struct{ board, id, title, session string }{{"alpha", "Alpha Dev", "Dev", effSessA}, {"alpha", "Beta Dev", "Dev", effSessB}, {"alpha", "Lead", "Orchestrator", "lead-session"}, {"beta", "Alpha Dev", "Dev", effSessA}, {"beta", "Lead", "Orchestrator", "lead-session"}} {
		_, err := bs.Subscribe(ctx, m.board, m.id, m.title, "claude-"+m.session, nil, "mentions")
		require.NoError(t, err)
	}
	e := &tasksEnv{now: now, boardPath: boardPath, t: t, h: h}
	e.srv = httptest.NewServer(http.HandlerFunc(h.Tasks))
	t.Cleanup(e.srv.Close)
	return e
}

// done writes a finished task: who did it, when it was claimed and done (ago from now), which session recorded it, and how it ended.
func (e *tasksEnv) done(board, title, agent, session string, claimAgo, doneAgo time.Duration, status, outcome string) {
	e.t.Helper()
	ctx := context.Background()
	bs := e.h.bs
	task, err := bs.CreateTask(ctx, board, title, "", "high", "Lead", agent)
	require.NoError(e.t, err)
	_, err = bs.ClaimTask(ctx, board, agent, task.ID)
	require.NoError(e.t, err)
	if status == "cancelled" {
		_, err = bs.CancelTask(ctx, board, task.ID, "Lead", nil)
	} else {
		_, err = bs.CompleteTask(ctx, board, task.ID, agent, nil)
	}
	require.NoError(e.t, err)
	raw, err := sql.Open("sqlite", e.boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(e.t, err)
	defer raw.Close()
	at := func(d time.Duration) string { return e.now.Add(-d).Format("2006-01-02T15:04:05Z") }
	_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = ?, completed_at = ?, input_tokens = 50, output_tokens = 50, cost_usd = 1, session_id = ? WHERE id = ?`, at(claimAgo), at(doneAgo), session, task.ID)
	require.NoError(e.t, err)
	if outcome != "" {
		_, err = raw.ExecContext(ctx, `INSERT INTO task_workflows (task_id, data) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data`, task.ID, fmt.Sprintf(`{"outcome":%q}`, outcome))
		require.NoError(e.t, err)
	}
}

type tasksBody struct {
	Bucket  string   `json:"bucket"`
	Buckets []string `json:"buckets"`
	Total   struct{ Completed, Failed int }
	Groups  []struct {
		Key, Label    string
		Completed     int
		Failed        int
		MedianSeconds *float64 `json:"median_seconds"`
		TokensPerTask *float64 `json:"tokens_per_task"`
		Series        []int
	}
}

func (e *tasksEnv) get(query string) (int, tasksBody) {
	e.t.Helper()
	resp, err := http.Get(e.srv.URL + "?" + query)
	require.NoError(e.t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out tasksBody
	if resp.StatusCode == 200 {
		require.NoError(e.t, json.Unmarshal(b, &out), string(b))
	}
	return resp.StatusCode, out
}

func (b tasksBody) count(key string) int {
	for _, g := range b.Groups {
		if g.Key == key {
			return g.Completed
		}
	}
	return -1
}

func TestAnalyticsTasksCountsWhatEachAgentCompleted(t *testing.T) {
	e := newTasksEnv(t)
	h := time.Hour
	e.done("alpha", "one", "Alpha Dev", effSessA, 3*h, 2*h, "completed", "")
	e.done("alpha", "two", "Alpha Dev", effSessA, 5*h, 3*h, "completed", "failed") // 7200 s, failed
	e.done("alpha", "three", "Alpha Dev", effSessA, 50*h, 49*h, "completed", "")   // two days back: another bucket
	e.done("alpha", "four", "Beta Dev", effSessB, 2*h, h, "completed", "")
	e.done("beta", "five", "Alpha Dev", effSessA, 2*h, h, "completed", "")
	e.done("alpha", "cancelled one", "Alpha Dev", effSessA, 2*h, h, "cancelled", "")       // not a completed task
	e.done("alpha", "Review #9", "Beta Dev", effSessB, 2*h, h, "completed", "")            // a reviewer's own task
	e.done("alpha", "too old", "Alpha Dev", effSessA, 21*24*h+h, 20*24*h, "completed", "") // outside 14 days

	code, by := e.get("range=14d&group_by=agent")
	require.Equal(t, 200, code)
	assert.Equal(t, 5, by.Total.Completed, "cancelled, a review task and one out of the window are not counted")
	assert.Equal(t, 1, by.Total.Failed)
	assert.Equal(t, 4, by.count("Alpha Dev"), "Alpha Dev finished one, two, three and five")
	assert.Equal(t, 1, by.count("Beta Dev"))
	require.Len(t, by.Buckets, 14)
	for _, g := range by.Groups {
		sum := 0
		for _, n := range g.Series {
			sum += n
		}
		assert.Equal(t, g.Completed, sum, "%s: the series adds up to the table's count", g.Key)
	}
	alpha := by.Groups[0]
	assert.Equal(t, "Alpha Dev", alpha.Key, "the biggest group first")
	assert.Equal(t, 1, alpha.Failed, "Failed is its own column: one of Alpha Dev's four")
	require.NotNil(t, alpha.MedianSeconds)
	assert.InDelta(t, 3600, *alpha.MedianSeconds, 0.01, "the median of 3600, 7200, 3600 and 3600 seconds is the middle two averaged")
	require.NotNil(t, alpha.TokensPerTask)
	assert.InDelta(t, 100, *alpha.TokensPerTask, 0.01)

	_, withReviews := e.get("range=14d&group_by=agent&reviews=1")
	assert.Equal(t, 6, withReviews.Total.Completed, "with reviews the total is the board's completed count for the window (cancelled still out)")
	assert.Equal(t, 2, withReviews.count("Beta Dev"))

	// The board's own count for the same window, from its table.
	raw, err := sql.Open("sqlite", e.boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer raw.Close()
	var n int
	require.NoError(t, raw.QueryRow(`SELECT COUNT(*) FROM board_tasks WHERE status = 'completed' AND completed_at >= ?`, e.now.Add(-14*24*h).Format("2006-01-02T15:04:05Z")).Scan(&n))
	assert.Equal(t, n, withReviews.Total.Completed, "the same number the board holds")

	_, teams := e.get("range=14d&group_by=team")
	assert.Equal(t, 4, teams.count("alpha"), "alpha: one, two, three and four")
	assert.Equal(t, 1, teams.count("beta"))
	_, providers := e.get("range=14d&group_by=provider")
	assert.Equal(t, 4, providers.count("claude"))
	assert.Equal(t, 1, providers.count("codex"))
}

func TestAnalyticsTasksBucketsAndNotRecorded(t *testing.T) {
	e := newTasksEnv(t)
	h := time.Hour
	e.done("alpha", "just now", "Alpha Dev", effSessA, h, 0, "completed", "")                        // the newest bucket: done this second
	e.done("alpha", "first hour", "Alpha Dev", effSessA, 24*h, 23*h+10*time.Minute, "completed", "") // the oldest hourly bucket
	e.done("alpha", "no session 1", "Orphan", "", h, 30*time.Minute, "completed", "")
	e.done("alpha", "no session 2", "Orphan", "", h, 20*time.Minute, "completed", "")
	e.done("alpha", "no session 3", "Orphan", "", h, 10*time.Minute, "completed", "")

	code, day := e.get("range=24h&group_by=model")
	require.Equal(t, 200, code)
	assert.Equal(t, "hour", day.Bucket)
	require.Len(t, day.Buckets, 24)
	require.Len(t, day.Groups, 1, "the sessions here recorded no model")
	g := day.Groups[0]
	assert.Equal(t, "Not recorded", g.Key)
	assert.Equal(t, 5, g.Completed)
	assert.Equal(t, 4, g.Series[23], "the task done this second and the three from the last half hour are in the last bucket (the index is clamped to the last)")
	assert.Equal(t, 1, g.Series[0], "and one from 23 hours ago in the first")

	// "Not recorded" is last even when it is the biggest group.
	_, byAgent := e.get("range=24h&group_by=agent")
	require.Len(t, byAgent.Groups, 2)
	assert.Equal(t, "Orphan", byAgent.Groups[0].Key, "the biggest group first: 3 against 2")
	assert.Equal(t, 2, byAgent.count("Alpha Dev"))
	_, byProvider := e.get("range=24h&group_by=provider")
	require.GreaterOrEqual(t, len(byProvider.Groups), 2)
	assert.Equal(t, "Not recorded", byProvider.Groups[len(byProvider.Groups)-1].Key, "Not recorded last although it holds 3 of the 5")

	for _, bad := range []string{"range=1y", "group_by=colour"} {
		code, _ := e.get(bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

// #21111: the cost page's Team select narrows the tasks read to one board's tasks; the teams add up to the whole, and a board that no task names answers empty, never every team.
func TestAnalyticsTasksFollowTheTeamSelect(t *testing.T) {
	e := newTasksEnv(t)
	h := time.Hour
	e.done("alpha", "one", "Alpha Dev", effSessA, 3*h, 2*h, "completed", "")
	e.done("alpha", "two", "Beta Dev", effSessB, 3*h, 2*h, "completed", "")
	e.done("beta", "three", "Alpha Dev", effSessA, 2*h, h, "completed", "")

	_, all := e.get("range=14d&group_by=agent")
	_, alpha := e.get("range=14d&group_by=agent&team=alpha")
	_, beta := e.get("range=14d&group_by=agent&team=beta")
	assert.Equal(t, 3, all.Total.Completed)
	assert.Equal(t, 2, alpha.Total.Completed)
	assert.Equal(t, 1, beta.Total.Completed)
	assert.Equal(t, all.Total.Completed, alpha.Total.Completed+beta.Total.Completed, "the teams add up to the whole")
	assert.Equal(t, 1, alpha.count("Alpha Dev"), "only the tasks of that team")
	_, none := e.get("range=14d&group_by=agent&team=nosuchteam")
	assert.Equal(t, 0, none.Total.Completed)
	assert.Empty(t, none.Groups, "a team no task names is empty, never every team")
	code, _ := e.get("range=14d&team=" + string(make([]byte, 0)) + "a%20b")
	assert.Equal(t, 400, code, "a team is a team name")
}
