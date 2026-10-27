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
	now := time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)
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
		_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET claimed_at = ?, completed_at = ?, input_tokens = 50, output_tokens = 50, cost_usd = 1 WHERE id = ?`,
			e.now.Add(-claimAgo).Format("2006-01-02T15:04:05Z"), e.now.Add(-doneAgo).Format("2006-01-02T15:04:05Z"), task.ID)
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
