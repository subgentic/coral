package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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

// #8915: the efficiency read over real stores: usage rows with their thinking levels, commits recorded by sessions, tasks claimed and completed on a board.
const (
	effSessA = "0000000a-3864-4864-8864-00000000000a" // claude, team alpha, opus at high
	effSessB = "0000000b-3864-4864-8864-00000000000b" // codex, team alpha
	effSessG = "0000000c-3864-4864-8864-00000000000c" // gemini: no usage rows
)

type effEnv struct {
	h         *EfficiencyHandler
	srv       *httptest.Server
	now       time.Time
	boardPath string
	storePath string
}

func newEffEnv(t *testing.T) *effEnv {
	t.Helper()
	ctx := context.Background()
	storePath := filepath.Join(t.TempDir(), "s.db")
	db, err := storetest.Open(t, storePath)
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	boardPath := filepath.Join(t.TempDir(), "board.db")
	bs, err := boardtest.Open(boardPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	// The real clock, not a fixed date: a usage row recorded within 15 minutes of the real now is a live call, and takes its session's thinking level (liveCall), so a fixed date made this test fail for
	// a quarter of an hour of every day (09:00 to 09:15 UTC with the rows three hours before it). The rows here are all at least an hour old.
	now := time.Now().UTC().Truncate(time.Second)
	h := NewEfficiencyHandler(db, bs)
	h.now = func() time.Time { return now }
	ss := store.NewSessionStore(db)
	ts := store.NewTokenUsageStore(db)
	gs := store.NewGitStore(db)
	high := "high"
	for _, s := range []struct {
		id, typ, name string
		level         *string
	}{{effSessA, "claude", "Alpha Dev", &high}, {effSessB, "codex", "Beta Dev", nil}, {effSessG, "gemini", "Gem Dev", nil}} {
		board := "alpha"
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: s.id, AgentName: s.name, AgentType: s.typ, WorkingDir: "/w", BoardName: &board, Thinking: s.level}))
		_, err := db.ExecContext(ctx, `UPDATE live_sessions SET created_at = ? WHERE session_id = ?`, now.Add(-30*24*time.Hour).Format(store.ISOFormat), s.id)
		require.NoError(t, err)
	}
	use := func(sid, typ, name, model, thinking string, tokens int, cost float64, ago time.Duration) {
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: sid, AgentName: name, AgentType: typ, BoardName: ptrString("alpha"), InputTokens: tokens / 2, OutputTokens: tokens - tokens/2,
			TotalTokens: tokens, CostUSD: cost, Model: model, Thinking: thinking, Source: "jsonl", RecordedAt: now.Add(-ago).Format(store.ISOFormat)}))
	}
	use(effSessA, "claude", "Alpha Dev", "opus", "high", 600, 6, 2*time.Hour)
	use(effSessA, "claude", "Alpha Dev", "sonnet", "", 400, 1, 3*time.Hour) // no level recorded
	use(effSessB, "codex", "Beta Dev", "gpt", "low", 1000, 2, 2*time.Hour)
	use(effSessA, "claude", "Alpha Dev", "opus", "high", 9000, 90, 10*24*time.Hour) // in the seven days before the window ("the usual")
	commit := func(sid, typ, name, branch, hash string, ago time.Duration) {
		at := now.Add(-ago).Format(time.RFC3339)
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: name, AgentType: typ, WorkingDirectory: "/w", Branch: branch, CommitHash: hash, CommitTimestamp: &at, SessionID: &sid}))
	}
	commit(effSessA, "claude", "Alpha Dev", "feature", "c1", time.Hour)
	commit(effSessA, "claude", "Alpha Dev", "feature", "c2", 90*time.Minute)
	commit(effSessB, "codex", "Beta Dev", "ui", "c3", time.Hour)
	commit(effSessB, "codex", "Beta Dev", "ui", "c4", 2*time.Hour)
	commit(effSessG, "gemini", "Gem Dev", "main", "c5", time.Hour)
	commit(effSessA, "claude", "Alpha Dev", "feature", "old", 20*24*time.Hour)  // before the window and before the usual
	commit(effSessA, "claude", "Alpha Dev", "feature", "older", 9*24*time.Hour) // in the seven days before it
	h2 := &effEnv{h: h, now: now, boardPath: boardPath, storePath: storePath}
	h2.srv = httptest.NewServer(http.HandlerFunc(h.Efficiency))
	t.Cleanup(h2.srv.Close)
	return h2
}

func (e *effEnv) get(t *testing.T, query string) (int, map[string]any) {
	t.Helper()
	resp, err := http.Get(e.srv.URL + "/?" + query)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func groupsOf(t *testing.T, body map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	list, _ := body["groups"].([]any)
	for _, g := range list {
		m := g.(map[string]any)
		out[fmt.Sprint(m["key"])] = m
	}
	return out
}

func TestEfficiencyTokensPerCommitByProviderAndThinking(t *testing.T) {
	e := newEffEnv(t)
	code, body := e.get(t, "metric=tokens_per_commit&group_by=provider&range=7d")
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, "tokens_per_commit", body["metric"])
	assert.EqualValues(t, 10, body["min_sample"])
	g := groupsOf(t, body)
	require.Contains(t, g, "claude")
	assert.EqualValues(t, 1000, g["claude"]["tokens"])
	assert.EqualValues(t, 2, g["claude"]["n"])
	assert.InDelta(t, 500, g["claude"]["value"], 0.001, "the old commit and the old usage are out of the window")
	assert.Equal(t, "Claude", g["claude"]["label"])
	assert.InDelta(t, 500, g["codex"]["value"], 0.001)
	assert.NotContains(t, g, "gemini", "its commit is left out")
	assert.Equal(t, []any{"gemini"}, body["unmeasured"])
	assert.EqualValues(t, 4, body["total"].(map[string]any)["n"])
	avg := body["average"].(map[string]any)
	assert.InDelta(t, 500, avg["value"], 0.001)
	assert.InDelta(t, 9000, avg["usual"], 0.001, "the 7 days before: 9000 tokens over one commit")

	code, body = e.get(t, "metric=tokens_per_commit&group_by=thinking&range=7d")
	require.Equal(t, http.StatusOK, code)
	g = groupsOf(t, body)
	assert.Equal(t, "Not recorded", g[""]["label"], "the rows that recorded no level")
	assert.EqualValues(t, 400, g[""]["tokens"])
	assert.EqualValues(t, 600, g["high"]["tokens"])
	assert.True(t, g["high"]["low_sample"] == true)
}

func TestEfficiencyRefusesWhatItCannotAnswer(t *testing.T) {
	e := newEffEnv(t)
	for _, q := range []string{"group_by=team", "metric=speed&group_by=team", "metric=task_time", "metric=task_time&group_by=shoe", "metric=task_time&group_by=team&range=3d"} {
		code, body := e.get(t, q)
		assert.Equal(t, http.StatusBadRequest, code, q)
		assert.NotEmpty(t, body["error"], q)
	}
	code, body := e.get(t, "metric=task_time&group_by=team")
	assert.Equal(t, http.StatusOK, code, "the range defaults to 7d")
	assert.Equal(t, "7d", body["range"])
	assert.NotNil(t, body["groups"], "an empty answer is an empty list, not null")
	assert.NotNil(t, body["unmeasured"])
}

func TestEfficiencyTeamFilter(t *testing.T) {
	e := newEffEnv(t)
	code, body := e.get(t, "metric=tokens_per_commit&group_by=provider&team=other")
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, groupsOf(t, body))
	code, body = e.get(t, "metric=tokens_per_commit&group_by=team&team=alpha")
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, groupsOf(t, body), "alpha")
}

func TestEfficiencyTaskTimeByThinkingLevelAndSentBackShare(t *testing.T) {
	e := newEffEnv(t)
	ctx := context.Background()
	bs := e.h.bs
	_, err := bs.Subscribe(ctx, "alpha", "Alpha Dev", "Dev", "claude-"+effSessA, nil, "mentions")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "lead-session", nil, "all")
	require.NoError(t, err)
	finish := func(title, level string, claimAgo, doneAgo time.Duration) int64 {
		task, err := bs.CreateTask(ctx, "alpha", title, "", "high", "Lead", "Alpha Dev")
		require.NoError(t, err)
		_, err = bs.ClaimTask(ctx, "alpha", "Alpha Dev", task.ID)
		require.NoError(t, err)
		require.NoError(t, bs.SetClaimThinking(ctx, "alpha", task.ID, level))
		_, err = bs.CompleteTask(ctx, "alpha", task.ID, "Alpha Dev", nil)
		require.NoError(t, err)
		raw, err := sql.Open("sqlite", e.boardPath+"?_pragma=busy_timeout(5000)")
		require.NoError(t, err)
		defer raw.Close()
		_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = ?, completed_at = ?, input_tokens = 50, output_tokens = 50, cost_usd = 1, session_id = ? WHERE id = ?`,
			e.now.Add(-claimAgo).Format("2006-01-02T15:04:05Z"), e.now.Add(-doneAgo).Format("2006-01-02T15:04:05Z"), effSessA, task.ID)
		require.NoError(t, err)
		return task.ID
	}
	finish("a", "high", 3*time.Hour, 2*time.Hour)            // 3600 s
	finish("b", "high", 5*time.Hour, 3*time.Hour)            // 7200 s
	finish("c", "", 4*time.Hour, 3*time.Hour+30*time.Minute) // 1800 s, no level recorded

	code, body := e.get(t, "metric=task_time&group_by=thinking&range=24h")
	require.Equal(t, http.StatusOK, code, "%v", body)
	g := groupsOf(t, body)
	assert.EqualValues(t, 2, g["high"]["n"])
	assert.InDelta(t, 5400, g["high"]["value"], 0.001, "the median of 3600 and 7200")
	assert.EqualValues(t, 200, g["high"]["tokens"])
	assert.InDelta(t, 1, g["high"]["cost_usd_per_unit"], 0.001)
	assert.InDelta(t, 0, g["high"]["sent_back_share"], 0.001)
	assert.Equal(t, "Not recorded", g[""]["label"])
	assert.InDelta(t, 1800, g[""]["value"], 0.001)

	code, body = e.get(t, "metric=task_time&group_by=provider&range=24h")
	require.Equal(t, http.StatusOK, code)
	g = groupsOf(t, body)
	assert.EqualValues(t, 3, g["claude"]["n"], "the claimer's session is a claude one")
	code, body = e.get(t, "metric=task_time&group_by=agent&range=24h")
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, groupsOf(t, body), "Alpha Dev")
	code, body = e.get(t, "metric=task_time&group_by=task&range=24h")
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, groupsOf(t, body), 3)
}

// A commit made before its session began is one the agent found there, not one it made: it is not counted.
func TestEfficiencyIgnoresACommitFromBeforeTheSessionBegan(t *testing.T) {
	e := newEffEnv(t)
	raw, err := sql.Open("sqlite", e.storePath+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer raw.Close()
	// codex's session began 90 minutes ago: its commits from 1 hour and 2 hours ago are one it made and one it found
	_, err = raw.Exec(`UPDATE live_sessions SET created_at = ? WHERE session_id = ?`, e.now.Add(-90*time.Minute).Format(store.ISOFormat), effSessB)
	require.NoError(t, err)
	code, body := e.get(t, "metric=tokens_per_commit&group_by=provider")
	require.Equal(t, http.StatusOK, code)
	assert.EqualValues(t, 1, groupsOf(t, body)["codex"]["n"])
}

// finishedTask makes a completed task of Alpha Dev on the alpha board: claimed claimAgo before the test's now, done doneAgo before it, with the session recorded at its claim (sid, "" for none).
func (e *effEnv) finishedTask(t *testing.T, title, sid string, claimAgo, doneAgo time.Duration) int64 {
	t.Helper()
	ctx := context.Background()
	bs := e.h.bs
	_, _ = bs.Subscribe(ctx, "alpha", "Lead", "Orchestrator", "lead-session", nil, "all")
	_, _ = bs.Subscribe(ctx, "alpha", "Alpha Dev", "Dev", "claude-"+effSessB, nil, "mentions") // a session the agent was restarted on since
	task, err := bs.CreateTask(ctx, "alpha", title, "", "high", "Lead", "Alpha Dev")
	require.NoError(t, err)
	_, err = bs.ClaimTask(ctx, "alpha", "Alpha Dev", task.ID)
	require.NoError(t, err)
	_, err = bs.CompleteTask(ctx, "alpha", task.ID, "Alpha Dev", nil)
	require.NoError(t, err)
	raw, err := sql.Open("sqlite", e.boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer raw.Close()
	_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = ?, completed_at = ?, input_tokens = 50, output_tokens = 50, cost_usd = 1, session_id = NULLIF(?, '') WHERE id = ?`,
		e.now.Add(-claimAgo).Format("2006-01-02T15:04:05Z"), e.now.Add(-doneAgo).Format("2006-01-02T15:04:05Z"), sid, task.ID)
	require.NoError(t, err)
	return task.ID
}

// #8968 (1): a task is the work of the session recorded at its claim. The agent was restarted on another session since: the task keeps the first one's provider and commits.
func TestEfficiencyATaskKeepsTheSessionOfItsClaim(t *testing.T) {
	e := newEffEnv(t)
	id := e.finishedTask(t, "done before the restart", effSessA, 3*time.Hour, 20*time.Minute) // c1 (1 h ago) and c2 (90 min) are session A's
	code, body := e.get(t, "metric=tokens_per_commit&group_by=task&range=24h")
	require.Equal(t, http.StatusOK, code)
	g := groupsOf(t, body)[fmt.Sprint(id)]
	require.NotNil(t, g)
	assert.EqualValues(t, 2, g["n"], "both of session A's commits, though the agent is on session B now")
	assert.InDelta(t, 50, g["value"], 0.001)
	code, body = e.get(t, "metric=task_time&group_by=provider&range=24h")
	require.Equal(t, http.StatusOK, code)
	assert.Contains(t, groupsOf(t, body), "claude", "session A is a claude one; the restarted session is codex")
	assert.NotContains(t, groupsOf(t, body), "codex")
}

// #8968 (2): a commit goes to one task. Two tasks of one session overlap; a commit exactly at one's end and the next's claim is the next's.
func TestEfficiencyACommitCountsForOneTaskOnly(t *testing.T) {
	e := newEffEnv(t)
	first := e.finishedTask(t, "first", effSessA, 3*time.Hour, 70*time.Minute)    // c2 (90 min ago) is inside; c1 (60 min ago) is not
	second := e.finishedTask(t, "second", effSessA, 2*time.Hour, 20*time.Minute)  // c2 and c1 are inside it too: the latest-claimed wins both
	third := e.finishedTask(t, "third", effSessA, 20*time.Minute, 10*time.Minute) // nothing in it
	_ = third
	code, body := e.get(t, "metric=tokens_per_commit&group_by=task&range=24h")
	require.Equal(t, http.StatusOK, code)
	g := groupsOf(t, body)
	assert.EqualValues(t, 0, g[fmt.Sprint(first)]["n"], "the second task was claimed later and was open: it has both")
	assert.EqualValues(t, 2, g[fmt.Sprint(second)]["n"])
	assert.EqualValues(t, 2, body["total"].(map[string]any)["n"], "never more than the commits there are")
}

func TestEfficiencyACommitAtOneTasksEndIsTheNextTasks(t *testing.T) {
	e := newEffEnv(t)
	a := e.finishedTask(t, "ends at c1", effSessA, 3*time.Hour, time.Hour) // ends at the instant of c1 (1 h ago): half-open, so not in it
	b := e.finishedTask(t, "starts at c1", effSessA, time.Hour, 10*time.Minute)
	_, body := e.get(t, "metric=tokens_per_commit&group_by=task&range=24h")
	g := groupsOf(t, body)
	assert.EqualValues(t, 1, g[fmt.Sprint(a)]["n"], "c2 (90 min ago) only")
	assert.EqualValues(t, 1, g[fmt.Sprint(b)]["n"], "c1, made at its claim")
}

// #8968 (3): one rule for both measures: a task of Gemini (no usage) or of no known session is in neither; Gemini is named as unmeasured by both.
func TestEfficiencyBothMeasuresLeaveOutTasksTheyCannotRead(t *testing.T) {
	e := newEffEnv(t)
	e.finishedTask(t, "claude task", effSessA, 3*time.Hour, 2*time.Hour)
	e.finishedTask(t, "gemini task", effSessG, 3*time.Hour, 2*time.Hour)
	e.finishedTask(t, "no session", "", 3*time.Hour, 2*time.Hour)
	for _, metric := range []string{"task_time", "tokens_per_commit"} {
		code, body := e.get(t, "metric="+metric+"&group_by=task&range=24h")
		require.Equal(t, http.StatusOK, code)
		assert.Len(t, groupsOf(t, body), 1, metric+": only the claude task")
		assert.Equal(t, []any{"gemini", "unknown"}, body["unmeasured"], metric+": the task of no recorded session is named too")
	}
	_, body := e.get(t, "metric=task_time&group_by=provider&range=24h")
	assert.EqualValues(t, 1, body["total"].(map[string]any)["n"])
}

// #8968 (4): a rebased or cherry-picked copy of a commit (new hash, same subject and author time) is one commit; a commit already on the branch when a session began is another session's, and goes to the first
// session that had begun.
func TestEfficiencyCommitsAreCountedOnceAcrossRebasesAndSessions(t *testing.T) {
	e := newEffEnv(t)
	ctx := context.Background()
	db, err := storetest.Open(t, e.storePath)
	require.NoError(t, err)
	gs := store.NewGitStore(db)
	at := e.now.Add(-5 * time.Hour).Format(time.RFC3339)
	snap := func(sid, typ, name, hash string) {
		sidp := sid
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: name, AgentType: typ, WorkingDirectory: "/w", Branch: "feat", CommitHash: hash, CommitSubject: "Fix the thing", CommitTimestamp: &at, SessionID: &sidp}))
	}
	// codex's session began 90 minutes ago: the 5-hour-old commit was there before. It polled it first; claude's session (began 30 days ago) is the author.
	_, err = db.ExecContext(ctx, `UPDATE live_sessions SET created_at = ? WHERE session_id = ?`, e.now.Add(-90*time.Minute).Format(store.ISOFormat), effSessB)
	require.NoError(t, err)
	snap(effSessB, "codex", "Beta Dev", "aaa1")
	snap(effSessA, "claude", "Alpha Dev", "aaa1")
	snap(effSessA, "claude", "Alpha Dev", "bbb2") // the same commit rebased: another hash, same subject and time
	code, body := e.get(t, "metric=tokens_per_commit&group_by=provider&range=24h")
	require.Equal(t, http.StatusOK, code)
	g := groupsOf(t, body)
	assert.EqualValues(t, 3, g["claude"]["n"], "c1, c2 and the one commit, once (not twice for its two hashes)")
	assert.EqualValues(t, 1, g["codex"]["n"], "codex keeps only c3 (c4, 2 h old, was there before it began)")
}

// #8968 (5): a session that has ended (no live row) is held to the same rule: its start is read from its usage rows.
func TestEfficiencyTheFoundItThereRuleHoldsForEndedSessions(t *testing.T) {
	e := newEffEnv(t)
	ctx := context.Background()
	db, err := storetest.Open(t, e.storePath)
	require.NoError(t, err)
	ended := "0000000d-3864-4864-8864-00000000000d"
	ts := store.NewTokenUsageStore(db)
	require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: ended, AgentName: "Gone", AgentType: "claude", BoardName: ptrString("alpha"), InputTokens: 100, TotalTokens: 100, Source: "jsonl",
		SessionStartAt: e.now.Add(-30 * time.Minute).Format(store.ISOFormat), RecordedAt: e.now.Add(-20 * time.Minute).Format(store.ISOFormat)}))
	gs := store.NewGitStore(db)
	for hash, ago := range map[string]time.Duration{"found": 3 * time.Hour, "made": 10 * time.Minute} {
		at := e.now.Add(-ago).Format(time.RFC3339)
		sid := ended
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "Gone", AgentType: "claude", WorkingDirectory: "/w", Branch: "x", CommitHash: hash, CommitTimestamp: &at, SessionID: &sid}))
	}
	_, body := e.get(t, "metric=tokens_per_commit&group_by=agent&range=24h")
	assert.EqualValues(t, 1, groupsOf(t, body)["Gone"]["n"], "the commit from 3 h ago was on the branch before the session began, 30 minutes ago")
}

// #8968 (item 16): an error reply carries no store text.
func TestEfficiencyAFailedReadSaysNothingOfTheStore(t *testing.T) {
	e := newEffEnv(t)
	require.NoError(t, e.h.bs.Close())
	code, body := e.get(t, "metric=task_time&group_by=team&range=24h")
	assert.Equal(t, http.StatusInternalServerError, code)
	assert.Equal(t, "the efficiency read failed", body["error"])
}

// #8996 (H4c): a session that pulled a teammate's commit before the author's session polled it is not credited: the commit goes to the session whose identity its author matches.
func TestEfficiencyAPulledCommitIsNotCreditedToTheSessionThatPulledIt(t *testing.T) {
	e := newEffEnv(t)
	ctx := context.Background()
	db, err := storetest.Open(t, e.storePath)
	require.NoError(t, err)
	gs := store.NewGitStore(db)
	at := e.now.Add(-30 * time.Minute).Format(time.RFC3339)
	snap := func(sid, typ, name string) {
		s := sid
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: name, AgentType: typ, WorkingDirectory: "/w", Branch: "main", CommitHash: "pulled1", CommitSubject: "Beta's work", CommitTimestamp: &at, SessionID: &s,
			AuthorName: "Beta Dev", AuthorHash: "beta-pseudonym", IdentName: "Operator", IdentHash: "operator-pseudonym"}))
	}
	snap(effSessA, "claude", "Alpha Dev") // it pulled the commit and polled it first
	snap(effSessB, "codex", "Beta Dev")   // the author's session
	_, body := e.get(t, "metric=tokens_per_commit&group_by=agent&range=24h")
	g := groupsOf(t, body)
	assert.EqualValues(t, 2, g["Alpha Dev"]["n"], "c1 and c2, not the pulled commit")
	assert.EqualValues(t, 3, g["Beta Dev"]["n"], "c3, c4 and the commit it made")
}

// #8999: a sent-back task's commits are those of every round of its work, as its tokens and time are.
func TestEfficiencyASentBackTasksCommitsCoverAllItsRounds(t *testing.T) {
	e := newEffEnv(t)
	id := e.finishedTask(t, "sent back once", effSessA, 50*time.Minute, 20*time.Minute) // the last round holds no commit
	raw, err := sql.Open("sqlite", e.boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer raw.Close()
	first := fmt.Sprintf(`[["%s","%s"]]`, e.now.Add(-100*time.Minute).Format("2006-01-02T15:04:05Z"), e.now.Add(-80*time.Minute).Format("2006-01-02T15:04:05Z")) // c2 (90 min ago) is in the first round
	_, err = raw.Exec(`UPDATE board_tasks SET work_windows = ?, work_before_seconds = 1200 WHERE id = ?`, first, id)
	require.NoError(t, err)
	_, body := e.get(t, "metric=tokens_per_commit&group_by=task&range=24h")
	assert.EqualValues(t, 1, groupsOf(t, body)[fmt.Sprint(id)]["n"], "the first round's commit")
}

// #9151: the read takes the commits of both windows in one pass over the snapshots. Seeded with 30,000 commit snapshots over 30 days (and 10,000 usage rows), the request time is logged; the answer is
// the same as ever (the tests above), so this one asserts the figures that depend on both windows are there.
func TestEfficiencyOnASeededBoardAnswersBothWindowsAndLogsItsTime(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 30,000 snapshots")
	}
	e := newEffEnv(t)
	ctx := context.Background()
	db, err := storetest.Open(t, e.storePath)
	require.NoError(t, err)
	now := e.now
	tx, err := db.BeginTxx(ctx, nil)
	require.NoError(t, err)
	for i := 0; i < 30000; i++ {
		sid := fmt.Sprintf("%08d-3864-4864-8864-0000000000%02d", i%30, i%30)
		at := now.Add(-time.Duration((i*7919)%(30*24*60)) * time.Minute).Format(time.RFC3339)
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO git_snapshots (agent_name, agent_type, working_directory, branch, commit_hash, commit_subject, commit_timestamp, session_id, recorded_at)
			VALUES (?, 'claude', '/w', ?, ?, ?, ?, ?, ?)`, "Agent "+fmt.Sprint(i%30), "branch-"+fmt.Sprint(i%7), fmt.Sprintf("%040d", i), "Commit "+fmt.Sprint(i), at, sid, now.Format(store.ISOFormat))
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit())
	ts := store.NewTokenUsageStore(db)
	batch := make([]*store.TokenUsage, 0, 500)
	for i := 0; i < 10000; i++ {
		sid := fmt.Sprintf("%08d-3864-4864-8864-0000000000%02d", i%30, i%30)
		at := now.Add(-time.Duration((i*104729)%(30*24*60)+30) * time.Minute)
		batch = append(batch, &store.TokenUsage{SessionID: sid, AgentName: "Agent " + fmt.Sprint(i%30), AgentType: "claude", BoardName: ptrString("alpha"), InputTokens: 1000, OutputTokens: 250, TotalTokens: 1250, CostUSD: 0.01, Model: "opus", Source: "jsonl", RecordedAt: at.Format(store.ISOFormat)})
		if len(batch) == cap(batch) {
			for _, err := range ts.RecordUsageBatch(ctx, batch) {
				require.NoError(t, err)
			}
			batch = batch[:0]
		}
	}
	for _, err := range ts.RecordUsageBatch(ctx, batch) {
		require.NoError(t, err)
	}
	best := time.Duration(1<<63 - 1)
	var body map[string]any
	for i := 0; i < 5; i++ {
		t0 := time.Now()
		_, body = e.get(t, "metric=tokens_per_commit&group_by=agent&range=7d")
		if d := time.Since(t0); d < best {
			best = d
		}
	}
	t.Logf("30,000 commit snapshots and 10,000 usage rows over 30 days: the efficiency read (tokens per commit by agent, 7d) takes %v at best of 5", best)
	avg := body["average"].(map[string]any)
	assert.NotNil(t, avg["value"], "the current window has its figure")
	assert.NotNil(t, avg["usual"], "and so has the usual one, from the same read")
	assert.Greater(t, body["total"].(map[string]any)["n"], float64(1000))
}

// #9151 (Security Reviewer's SHOULD): what the one shared read rests on. A commit only the usual window has must reach the usual figure, though it is older than the current window's reach; and the current
// window takes commits only from its own slack (a task open longer than that has the last 14 days of its commits), not from the usual window's.
func TestEfficiencyTheSharedCommitReadServesTheUsualWindowAndKeepsEachWindowsSlack(t *testing.T) {
	e := newEffEnv(t)
	ctx := context.Background()
	db, err := storetest.Open(t, e.storePath)
	require.NoError(t, err)
	gs := store.NewGitStore(db)
	day := 24 * time.Hour
	commit := func(hash string, ago time.Duration) {
		at := e.now.Add(-ago).Format(time.RFC3339)
		sid := effSessA
		require.NoError(t, gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "Alpha Dev", AgentType: "claude", WorkingDirectory: "/w", Branch: "feature", CommitHash: hash, CommitTimestamp: &at, SessionID: &sid}))
	}
	commit("u1", 24*day)                                                                 // in the usual window's slack, further back than the current window's reach (21 days): only a shared read that reaches 28 days gives it to the usual figure
	commit("far", 22*day)                                                                // in the usual window's slack, and outside the current window's (a task open that long has only its last 14 days)
	commit("near", 5*day)                                                                // inside the current window's slack
	usualTask := e.finishedTask(t, "done in the usual window", effSessA, 25*day, 10*day) // claimed 25 days ago: u1 and far are made while it is open
	curTask := e.finishedTask(t, "done in the current window", effSessA, 23*day, day)    // claimed 23 days ago: far is outside the slack, near is inside
	code, body := e.get(t, "metric=tokens_per_commit&group_by=task&range=7d")
	require.Equal(t, http.StatusOK, code)
	g := groupsOf(t, body)
	require.Contains(t, g, fmt.Sprint(curTask))
	// the fixture's own session-A commits count too: "old" (20 days ago) and "older" (9 days ago) lie in both tasks' windows
	assert.EqualValues(t, 3, g[fmt.Sprint(curTask)]["n"], "the current window keeps only the commits inside its own slack: old, older and near, not far (22 days: a fourth if the lower bound were dropped)")
	assert.NotContains(t, g, fmt.Sprint(usualTask), "the usual window's task is not in the current figure")
	avg := body["average"].(map[string]any)
	assert.InDelta(t, 100.0/3, avg["value"], 0.001, "the current figure: 100 tokens over old, older and near")
	require.NotNil(t, avg["usual"], "the usual figure has its commits")
	assert.InDelta(t, 100.0/3, avg["usual"], 0.001, "the usual window's one task, 100 tokens over u1, far and old (a shared read that stopped at 21 days would lose u1: 50)")
}
