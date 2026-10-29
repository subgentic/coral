package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #7525: the Analytics view's data for one team. The fixture is a real repository (commits by role names), three agents on one board (Claude, Codex, Gemini), token rows and tool-use events in and before
// the window, completed tasks, and a fixed clock.
type spendRig struct {
	h      *SpendHandler
	r      chi.Router
	bs     *board.Store
	repo   string
	board  string
	events *store.TaskStore
}

func spendGit(t *testing.T, dir, author, date string, args ...string) {
	t.Helper()
	cmd := gitutil.Command(context.Background(), dir, args...)
	cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL=a@example.invalid",
		"GIT_COMMITTER_NAME=Committer", "GIT_COMMITTER_EMAIL=c@example.invalid", "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
}

func spendCommit(t *testing.T, dir, author, date, file string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(dir, file), []byte(file+date), 0o644))
	spendGit(t, dir, author, date, "add", file)
	spendGit(t, dir, author, date, "commit", "-q", "-m", "work on "+file)
}

func newSpendRig(t *testing.T) *spendRig {
	t.Helper()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	boardPath := filepath.Join(t.TempDir(), "board.db")
	bs, err := boardtest.Open(boardPath)
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	repo, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	spendGit(t, repo, "x", "2026-10-01T00:00:00Z", "init", "-q", "-b", "main")

	ctx := context.Background()
	h := NewSpendHandler(db, bs)
	h.now = func() time.Time { return time.Date(2026, 10, 25, 10, 30, 0, 0, time.UTC) } // the 24 h window is 2026-10-24T11:00Z to 2026-10-25T11:00Z; the usual starts 2026-10-17T11:00Z
	b, err := bs.CreateBoard(ctx, "Alpha team", "Lead")
	require.NoError(t, err)
	rig := &spendRig{h: h, bs: bs, repo: repo, board: b.ID, events: store.NewTaskStore(db)}
	rig.r = chi.NewRouter()
	rig.r.Get("/api/board/{project}/spend", h.Spend)

	task, err := bs.CreateTask(ctx, rig.board, "first", "", "medium", "Lead") // makes the board
	require.NoError(t, err)
	_, err = bs.CreateTask(ctx, rig.board, "second", "", "medium", "Lead")
	require.NoError(t, err)

	ss := store.NewSessionStore(db)
	for _, a := range []struct{ id, typ, name string }{
		{"aaaaaaaa-7525-4000-8000-000000000001", "claude", "Backend Dev"},
		{"bbbbbbbb-7525-4000-8000-000000000002", "codex", "QA Engineer"},
		{"cccccccc-7525-4000-8000-000000000003", "gemini", "Gemini Dev"},
	} {
		name, bn := a.name, rig.board
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: a.id, AgentType: a.typ, AgentName: "folder-" + a.typ, WorkingDir: repo, DisplayName: &name, BoardName: &bn}))
	}
	ts := store.NewTokenUsageStore(db)
	rec := func(sid, typ, name, at string, in, out, cr, cw int) {
		bn := rig.board
		require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: sid, AgentName: name, AgentType: typ, BoardName: &bn, InputTokens: in, OutputTokens: out, CacheReadTokens: cr, CacheWriteTokens: cw,
			TotalTokens: in + out, RecordedAt: at, Source: "jsonl"}))
	}
	rec("aaaaaaaa-7525-4000-8000-000000000001", "claude", "Backend Dev", "2026-10-25T09:10:00Z", 1000, 500, 8000, 200)
	rec("aaaaaaaa-7525-4000-8000-000000000001", "claude", "Backend Dev", "2026-10-25T10:10:00Z", 300, 100, 2000, 0)
	rec("bbbbbbbb-7525-4000-8000-000000000002", "codex", "QA Engineer", "2026-10-25T09:40:00Z", 700, 300, 5000, 0)
	rec("aaaaaaaa-7525-4000-8000-000000000001", "claude", "Backend Dev", "2026-10-20T10:10:00Z", 4000, 1000, 9000, 100) // the usual
	rec("bbbbbbbb-7525-4000-8000-000000000002", "codex", "QA Engineer", "2026-10-21T10:10:00Z", 2000, 500, 3000, 0)     // the usual
	// another board's agent, in the window: none of its tokens is this board's
	other := "b-other"
	require.NoError(t, ts.RecordUsage(ctx, &store.TokenUsage{SessionID: "dddddddd-7525-4000-8000-000000000004", AgentName: "Elsewhere", AgentType: "claude", BoardName: &other, InputTokens: 99999,
		OutputTokens: 99999, CacheReadTokens: 99999, CacheWriteTokens: 99999, TotalTokens: 199998, RecordedAt: "2026-10-25T09:20:00Z", Source: "jsonl"}))

	ev := func(sid, name, at string) {
		s := sid
		_, err := rig.events.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &s, EventType: "tool_use", Summary: "Ran: ls", CreatedAt: at})
		require.NoError(t, err)
	}
	for _, at := range []string{"2026-10-25T09:11:00+00:00", "2026-10-25T09:12:00+00:00", "2026-10-25T10:11:00+00:00"} {
		ev("aaaaaaaa-7525-4000-8000-000000000001", "Backend Dev", at)
	}
	ev("bbbbbbbb-7525-4000-8000-000000000002", "QA Engineer", "2026-10-25T09:41:00+00:00")
	ev("aaaaaaaa-7525-4000-8000-000000000001", "Backend Dev", "2026-10-20T10:11:00+00:00") // the usual
	ev("aaaaaaaa-7525-4000-8000-000000000001", "Backend Dev", "2026-10-26T10:11:00+00:00") // after the window: never

	spendCommit(t, repo, "Backend Dev", "2026-10-20T10:00:00Z", "u.txt") // the usual
	spendCommit(t, repo, "Backend Dev", "2026-10-25T09:00:00Z", "a.txt")
	spendCommit(t, repo, "Backend Dev", "2026-10-25T09:30:00Z", "b.txt")
	spendCommit(t, repo, "QA Engineer", "2026-10-25T09:45:00Z", "c.txt")
	spendCommit(t, repo, "A Person", "2026-10-25T09:50:00Z", "d.txt")

	raw, err := sqlx.Open("sqlite", boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(t, err)
	defer raw.Close()
	_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET status = 'completed', created_at = '2026-10-25T08:00:00Z', claimed_at = '2026-10-25T08:30:00Z', completed_at = '2026-10-25T09:30:00Z', completed_by = 'Backend Dev' WHERE id = ?`, task.ID)
	require.NoError(t, err)
	return rig
}

func (s *spendRig) get(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}

func TestSpendAnswersTokensCommitsToolCallsAndTaskTimesForTheWindowAndTheUsual(t *testing.T) {
	rig := newSpendRig(t)
	code, out := rig.get(t, "/api/board/"+rig.board+"/spend?range=24h")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, rig.board, out["board"])
	assert.Equal(t, "24h", out["range"])
	assert.EqualValues(t, 24, out["range_hours"])
	assert.Equal(t, "2026-10-24T11:00:00Z", out["window_start"])
	assert.Equal(t, "2026-10-25T11:00:00Z", out["window_end"])

	tokens := out["tokens"].(map[string]any)
	win, usual := tokens["window"].(map[string]any), tokens["usual"].(map[string]any)
	assert.EqualValues(t, 1000+300+700, win["input"])
	assert.EqualValues(t, 500+100+300, win["output"])
	assert.EqualValues(t, 8000+2000+5000, win["cache_read"], "cache reads are separate")
	assert.EqualValues(t, 200, win["cache_write"], "Claude reports a cache write")
	assert.EqualValues(t, 4000+2000, usual["input"])
	assert.EqualValues(t, 100, usual["cache_write"])

	commits := out["commits"].(map[string]any)
	assert.Equal(t, true, commits["available"])
	assert.Equal(t, "main", commits["branch"])
	assert.Equal(t, filepath.Base(rig.repo), commits["repo"], "the folder's name, not its path")
	assert.NotContains(t, commits, "path")
	assert.EqualValues(t, 4, commits["window"])
	assert.EqualValues(t, 1, commits["usual"])
	assert.EqualValues(t, 1, commits["unattributed"], "A Person matches no agent")

	tools := out["tool_calls"].(map[string]any)
	assert.EqualValues(t, 4, tools["window"], "the three of Claude and one of Codex; Gemini has no source and the later event is outside")
	assert.EqualValues(t, 1, tools["usual"])
	assert.EqualValues(t, 2, tools["measured_agents"])
	assert.EqualValues(t, 3, tools["of_agents"])

	agents := out["agents"].([]any)
	byName := map[string]map[string]any{}
	for _, a := range agents {
		m := a.(map[string]any)
		byName[m["name"].(string)] = m
	}
	require.Contains(t, byName, "Backend Dev")
	be := byName["Backend Dev"]
	assert.EqualValues(t, 1000+500+300+100, be["tokens"], "input plus output, cache write beside it")
	assert.EqualValues(t, 10000, be["cache_reads"])
	assert.EqualValues(t, 3, be["tool_calls"])
	assert.EqualValues(t, 2, be["commits"])
	assert.EqualValues(t, 1, be["tasks_done"])
	assert.EqualValues(t, 3600, be["work_median_s"], "claimed 08:30 to completed 09:30")
	assert.Equal(t, true, be["measured"])
	gem := byName["Gemini Dev"]
	assert.Equal(t, false, gem["measured"])
	assert.Nil(t, gem["tokens"], "no token source: not measured, never zero")
	assert.Nil(t, gem["tool_calls"])
	assert.Nil(t, gem["share"])
	assert.EqualValues(t, 1, byName["QA Engineer"]["commits"])
	assert.Equal(t, 1, int(num(byName["Unattributed"]["commits"])))
	assert.Nil(t, byName["Unattributed"]["tokens"])
	share := num(be["share"]) + num(byName["QA Engineer"]["share"])
	assert.InDelta(t, 1.0, share, 0.001, "the measured agents' shares add to one")
	assert.EqualValues(t, 2, out["measured_agents"])
	assert.EqualValues(t, 3, out["of_agents"])
	assert.Equal(t, "Backend Dev", agents[0].(map[string]any)["name"], "most tokens first")

	tt := out["task_time"].(map[string]any)
	assert.Equal(t, "review time (from assignment to approval)", tt["review_label"])
	assert.EqualValues(t, 1, tt["window"].(map[string]any)["done"])
	assert.EqualValues(t, 3600, tt["window"].(map[string]any)["median_s"])
	assert.NotContains(t, tt["window"], "review_median_s", "no review recorded: the key is left out, never 0")
	assert.NotContains(t, tt["usual"], "median_s", "no task in the usual period: left out")
	ttAgents := tt["agents"].([]any)
	require.Len(t, ttAgents, 1)
	assert.Equal(t, "Backend Dev", ttAgents[0].(map[string]any)["name"])
	assert.EqualValues(t, 1, ttAgents[0].(map[string]any)["done"])
	ttHours := tt["per_hour"].([]any)
	require.Len(t, ttHours, 24)
	ttDays := tt["per_day"].([]any)
	require.Len(t, ttDays, 7)
	assert.EqualValues(t, 1, ttDays[6].(map[string]any)["done"])
	assert.EqualValues(t, 1800, tt["window"].(map[string]any)["wait_median_s"])

	hours := out["per_hour"].([]any)
	require.Len(t, hours, 24, "an hour a point, oldest first")
	assert.Equal(t, "2026-10-24T11:00:00Z", hours[0].(map[string]any)["hour"])
	assert.Equal(t, "2026-10-25T10:00:00Z", hours[23].(map[string]any)["hour"])
	days := out["per_day"].([]any)
	require.Len(t, days, 7, "the 24 h view also gets the week, a bar a day: the six days before today and today")
	assert.Equal(t, "2026-10-19", days[0].(map[string]any)["day"])
	assert.Equal(t, "2026-10-25", days[6].(map[string]any)["day"])
	today := days[6].(map[string]any)
	assert.EqualValues(t, 1000+500+300+100+700+300, today["tokens"], "a day is the sum of its hours")
	assert.EqualValues(t, 200, today["cache_write"])
	assert.EqualValues(t, 4, today["commits"])
	assert.EqualValues(t, 4, today["tool_calls"])
	assert.EqualValues(t, 1, today["tasks_done"])
	twentieth := days[1].(map[string]any)
	assert.EqualValues(t, 4000+1000, twentieth["tokens"], "the 20th is in the week and in the usual period")
	assert.EqualValues(t, 1, twentieth["commits"])
	byHour := map[string]map[string]any{}
	for _, h := range hours {
		m := h.(map[string]any)
		byHour[m["hour"].(string)] = m
	}
	nine := byHour["2026-10-25T09:00:00Z"]
	assert.EqualValues(t, 1000+500+700+300, nine["tokens"], "input plus output")
	assert.EqualValues(t, 200, nine["cache_write"])
	assert.EqualValues(t, 4, nine["commits"])
	assert.EqualValues(t, 3, nine["tool_calls"])
	assert.EqualValues(t, 1, nine["tasks_done"])
}

func TestSpendRangeSevenDaysGivesSevenDaysAgainstTheSevenBefore(t *testing.T) {
	rig := newSpendRig(t)
	code, out := rig.get(t, "/api/board/"+rig.board+"/spend?range=7d")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, "2026-10-19T00:00:00Z", out["window_start"])
	assert.Equal(t, "2026-10-26T00:00:00Z", out["window_end"])
	days := out["per_day"].([]any)
	require.Len(t, days, 7)
	assert.Equal(t, "2026-10-19", days[0].(map[string]any)["day"])
	assert.Equal(t, "2026-10-25", days[6].(map[string]any)["day"])
	assert.NotContains(t, out, "per_hour")
	tokens := out["tokens"].(map[string]any)
	assert.EqualValues(t, 1000+300+700+4000+2000, tokens["window"].(map[string]any)["input"], "the 20th and 21st are in a seven-day window")
	assert.EqualValues(t, 5, out["commits"].(map[string]any)["window"], "the commit of the 20th is in this window")
	assert.EqualValues(t, 0, out["commits"].(map[string]any)["usual"])
	assert.EqualValues(t, 4+1, out["tool_calls"].(map[string]any)["window"])
}

func TestSpendRefusesWhatItDoesNotKnowAndAnswersNoRepositoryInWords(t *testing.T) {
	rig := newSpendRig(t)
	for name, path := range map[string]string{
		"a range":      "/api/board/" + rig.board + "/spend?range=30d",
		"an unknown q": "/api/board/" + rig.board + "/spend?range=24h&board=beta",
	} {
		code, _ := rig.get(t, path)
		assert.Equal(t, http.StatusBadRequest, code, name)
	}
	code, _ := rig.get(t, "/api/board/nosuch/spend?range=24h")
	assert.Equal(t, http.StatusNotFound, code)
	code, out := rig.get(t, "/api/board/"+rig.board+"/spend")
	assert.Equal(t, http.StatusOK, code, "24h is the default")
	assert.Equal(t, "24h", out["range"])

	// agents whose folders are in no repository: commits are said to be unavailable, never zero
	empty := newSpendRig(t)
	require.NoError(t, os.RemoveAll(filepath.Join(empty.repo, ".git")))
	code, out = empty.get(t, "/api/board/"+empty.board+"/spend?range=24h")
	require.Equal(t, http.StatusOK, code)
	commits := out["commits"].(map[string]any)
	assert.Equal(t, false, commits["available"])
	assert.NotEmpty(t, commits["reason"])
	assert.Nil(t, commits["window"])
	assert.Nil(t, out["per_hour"].([]any)[0].(map[string]any)["commits"])
}

// #7764: agy's tokens are measured (the token poller reads the PLANNER_RESPONSE rows of its transcript); Gemini writes none.
func TestSpendMeasuresTheTokensOfTheCLIsTheTokenPollerReads(t *testing.T) {
	for _, typ := range []string{agenttypes.Claude, agenttypes.Codex, agenttypes.Pi, agenttypes.Agy} {
		assert.True(t, tokenSources[typ], typ)
	}
	for _, typ := range []string{agenttypes.Gemini, agenttypes.Terminal} {
		assert.False(t, tokenSources[typ], typ)
	}
}

// #11105 (row 11): a Pi agent's tool calls are counted from the toolCall blocks of its session file (it has no hooks to record them): in the window, the usual and its own row, like the other agents', and a
// call outside the window is not counted.
func TestSpendCountsAPiAgentsToolCallsFromItsSessionFile(t *testing.T) {
	assert.True(t, toolSources[agenttypes.Pi])
	rig := newSpendRig(t)
	rig.h.reader = jsonl.NewSessionReader()
	ctx := context.Background()
	piSID := "eeeeeeee-7525-4000-8000-000000000005"
	name, bn := "Pi Dev", rig.board
	require.NoError(t, store.NewSessionStore(rig.h.db).RegisterLiveSession(ctx, &store.LiveSession{SessionID: piSID, AgentType: agenttypes.Pi, AgentName: "folder-pi", WorkingDir: rig.repo, DisplayName: &name, BoardName: &bn}))
	dataDir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dataDir)
	sd := filepath.Join(dataDir, "pi-sessions", piSID)
	require.NoError(t, os.MkdirAll(sd, 0o700))
	call := func(ts string, tools ...string) string {
		blocks := ""
		for i, tl := range tools {
			if i > 0 {
				blocks += ","
			}
			blocks += fmt.Sprintf(`{"type":"toolCall","id":"c%d","name":%q,"arguments":{}}`, i, tl)
		}
		return fmt.Sprintf(`{"type":"message","id":"a","parentId":null,"timestamp":%q,"message":{"role":"assistant","content":[%s],"stopReason":"toolUse"}}`, ts, blocks)
	}
	lines := []string{
		call("2026-10-25T09:15:00.000Z", "bash", "read"), // the window
		call("2026-10-25T10:05:00.000Z", "write"),        // the window
		call("2026-10-20T10:00:00.000Z", "bash"),         // the usual
		call("2026-10-26T10:00:00.000Z", "bash"),         // after the window: never
	}
	require.NoError(t, os.WriteFile(filepath.Join(sd, "2026-10-25T08-00-00-000Z_x.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o600))

	code, out := rig.get(t, "/api/board/"+rig.board+"/spend?range=24h")
	require.Equal(t, http.StatusOK, code)
	tools := out["tool_calls"].(map[string]any)
	assert.EqualValues(t, 4+3, tools["window"], "Claude's three and Codex's one, and Pi's three")
	assert.EqualValues(t, 1+1, tools["usual"])
	assert.EqualValues(t, 3, tools["measured_agents"])
	var pi map[string]any
	for _, a := range out["agents"].([]any) {
		if m := a.(map[string]any); m["name"] == "Pi Dev" {
			pi = m
		}
	}
	require.NotNil(t, pi)
	assert.Equal(t, true, pi["tool_calls_measured"])
	assert.EqualValues(t, 3, pi["tool_calls"])
}
