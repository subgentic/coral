package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jmoiron/sqlx"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8226: the branches of SpendHandler.Spend, pinned before it is split. spend_test.go has one rich fixture; these are small worlds, one per branch, so that a change to one branch fails its own case:
// the window arithmetic, the CLIs that have a token or a tool source, the names an agent goes by, how a commit finds its author, the share, the order, the cache-write null, task times by completer.
// The clock is 2026-10-25T10:30Z (the 24 h window is 2026-10-24T11:00Z to 2026-10-25T11:00Z, the usual starts 2026-10-17T11:00Z) unless a case sets its own.
type spendWorld struct {
	t         *testing.T
	h         *SpendHandler
	r         chi.Router
	bs        *board.Store
	ss        *store.SessionStore
	ts        *store.TokenUsageStore
	ev        *store.TaskStore
	db        *store.DB
	board     string
	boardPath string
	repo      string // a git repository on branch main with no commit yet
	taskN     int
}

var spendNow = time.Date(2026, 10, 25, 10, 30, 0, 0, time.UTC)

func newSpendWorld(t *testing.T, now time.Time) *spendWorld {
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
	h := NewSpendHandler(db, bs)
	h.now = func() time.Time { return now }
	b, err := bs.CreateBoard(context.Background(), "Beta team", "Lead")
	require.NoError(t, err)
	w := &spendWorld{t: t, h: h, bs: bs, ss: store.NewSessionStore(db), ts: store.NewTokenUsageStore(db), ev: store.NewTaskStore(db), db: db, board: b.ID, boardPath: boardPath, repo: repo}
	w.r = chi.NewRouter()
	w.r.Get("/api/board/{project}/spend", h.Spend)
	return w
}

func (w *spendWorld) get(query string) (int, map[string]any) {
	w.t.Helper()
	rec := httptest.NewRecorder()
	w.r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/board/"+w.board+"/spend"+query, nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// agent registers a live session of the board; display and folder may be empty, dir defaults to the repository.
func (w *spendWorld) agent(id, typ, display, folder, dir string) {
	w.t.Helper()
	if dir == "" {
		dir = w.repo
	}
	bn := w.board
	s := &store.LiveSession{SessionID: id, AgentType: typ, AgentName: folder, WorkingDir: dir, BoardName: &bn}
	if display != "" {
		s.DisplayName = &display
	}
	require.NoError(w.t, w.ss.RegisterLiveSession(context.Background(), s))
}

// member subscribes the role the agent has on the board; orchestrator sets the peek flag the page reads as "orchestrator".
func (w *spendWorld) member(role, typ, id string, orchestrator bool) {
	w.t.Helper()
	_, err := w.bs.Subscribe(context.Background(), w.board, role, role, naming.SessionName(typ, id), nil, "all", orchestrator)
	require.NoError(w.t, err)
}

func (w *spendWorld) usage(id, typ, name, at string, in, out, cr, cw int) {
	w.t.Helper()
	bn := w.board
	require.NoError(w.t, w.ts.RecordUsage(context.Background(), &store.TokenUsage{SessionID: id, AgentName: name, AgentType: typ, BoardName: &bn, InputTokens: in, OutputTokens: out, CacheReadTokens: cr,
		CacheWriteTokens: cw, TotalTokens: in + out, RecordedAt: at, Source: "jsonl"}))
}

func (w *spendWorld) toolUse(id, name, at string) {
	w.t.Helper()
	sid := id
	_, err := w.ev.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: "tool_use", Summary: "Ran: ls", CreatedAt: at})
	require.NoError(w.t, err)
}

// taskDone makes a task of the board and marks it completed by who at the given time (claimed an hour before).
func (w *spendWorld) taskDone(who, completedAt string) {
	w.t.Helper()
	w.taskN++
	ctx := context.Background()
	task, err := w.bs.CreateTask(ctx, w.board, "task "+string(rune('a'+w.taskN)), "", "medium", "Lead")
	require.NoError(w.t, err)
	raw, err := sqlx.Open("sqlite", w.boardPath+"?_pragma=busy_timeout(5000)")
	require.NoError(w.t, err)
	defer raw.Close()
	done, err := time.Parse(time.RFC3339, completedAt)
	require.NoError(w.t, err)
	_, err = raw.ExecContext(ctx, `UPDATE board_tasks SET status = 'completed', created_at = ?, claimed_at = ?, completed_at = ?, completed_by = ? WHERE id = ?`,
		done.Add(-2*time.Hour).Format(time.RFC3339), done.Add(-time.Hour).Format(time.RFC3339), completedAt, who, task.ID)
	require.NoError(w.t, err)
}

func agentsOf(out map[string]any) []map[string]any {
	var rows []map[string]any
	for _, a := range out["agents"].([]any) {
		rows = append(rows, a.(map[string]any))
	}
	return rows
}

func agentNamed(t *testing.T, out map[string]any, name string) map[string]any {
	t.Helper()
	for _, a := range agentsOf(out) {
		if a["name"] == name {
			return a
		}
	}
	require.Failf(t, "no such agent", "%q in %v", name, out["agents"])
	return nil
}

const (
	spA = "aaaaaaaa-8226-4000-8000-000000000001"
	spB = "bbbbbbbb-8226-4000-8000-000000000002"
	spC = "cccccccc-8226-4000-8000-000000000003"
	spD = "dddddddd-8226-4000-8000-000000000004"
	spE = "eeeeeeee-8226-4000-8000-000000000005"
	spF = "ffffffff-8226-4000-8000-000000000006"
)

func TestSpendEmptyBoardAnswersNullsAndZeroesNotMissingKeys(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Nil(t, out["agents"], "no agent: a null list")
	assert.EqualValues(t, 0, out["measured_agents"])
	assert.EqualValues(t, 0, out["of_agents"])
	win := out["tokens"].(map[string]any)["window"].(map[string]any)
	assert.EqualValues(t, 0, win["input"])
	assert.Nil(t, win["cache_write"], "no agent reports a cache write: null")
	tools := out["tool_calls"].(map[string]any)
	assert.Nil(t, tools["window"], "no agent has a tool source: null, never 0")
	assert.Nil(t, tools["usual"])
	assert.EqualValues(t, 0, tools["measured_agents"])
	commits := out["commits"].(map[string]any)
	assert.Equal(t, false, commits["available"])
	assert.Equal(t, "no repository found for this board's agents", commits["reason"])
	hours := out["per_hour"].([]any)
	require.Len(t, hours, 24)
	first := hours[0].(map[string]any)
	assert.Nil(t, first["commits"], "no repository: null")
	assert.Nil(t, first["tool_calls"])
	assert.Nil(t, first["cache_write"])
	assert.EqualValues(t, 0, first["tokens"])
	assert.Equal(t, []any{}, out["task_time"].(map[string]any)["agents"], "an empty list, not null")
	assert.Len(t, out["per_day"].([]any), 7)
}

func TestSpendEachCLIHasItsOwnTokenAndToolSource(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	types := []struct {
		id, typ, name       string
		tokens, tools, evts bool
	}{
		{spA, agenttypes.Claude, "Claude agent", true, true, true},
		{spB, agenttypes.Codex, "Codex agent", true, true, true},
		{spC, agenttypes.Pi, "Pi agent", true, true, true}, // its tool calls are counted from its session file (#11105): the events written here are not, and there is no file, so 0
		{spD, agenttypes.Agy, "Agy agent", true, true, true},
		{spE, agenttypes.Gemini, "Gemini agent", false, false, true},
		{spF, agenttypes.Terminal, "Terminal agent", false, false, true},
	}
	for i, a := range types {
		w.agent(a.id, a.typ, a.name, "folder-"+a.typ, "")
		w.usage(a.id, a.typ, a.name, "2026-10-25T09:10:00Z", 100*(i+1), 10, 1, 0)
		w.toolUse(a.id, a.name, "2026-10-25T09:11:00+00:00")
		w.toolUse(a.id, a.name, "2026-10-25T09:12:00+00:00")
	}
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	for _, a := range types {
		row := agentNamed(t, out, a.name)
		assert.Equal(t, a.tokens, row["measured"], a.typ+": tokens measured")
		assert.Equal(t, a.tools, row["tool_calls_measured"], a.typ+": tool calls measured")
		if a.tokens {
			assert.NotNil(t, row["tokens"], a.typ)
		} else {
			assert.Nil(t, row["tokens"], a.typ+": not measured, never zero")
		}
		if a.typ == agenttypes.Pi {
			assert.EqualValues(t, 0, row["tool_calls"], "pi: measured from its file, not from events: no file, no calls")
		} else if a.tools {
			assert.EqualValues(t, 2, row["tool_calls"], a.typ)
		} else {
			assert.Nil(t, row["tool_calls"], a.typ+": the events it wrote are not counted")
		}
	}
	assert.EqualValues(t, 4, out["measured_agents"], "Claude, Codex, Pi, agy")
	assert.EqualValues(t, 6, out["of_agents"])
	tools := out["tool_calls"].(map[string]any)
	assert.EqualValues(t, 4, tools["measured_agents"], "Claude, Codex, agy and Pi (from its file)")
	assert.EqualValues(t, 6, tools["window"], "two events each of the three with a source")
	assert.EqualValues(t, 6, tools["of_agents"])
}

func TestSpendTokensAreCountedByTheHourTheyFallIn(t *testing.T) {
	cases := []struct {
		name          string
		at            string
		window, usual int
	}{
		{"the first instant of the window", "2026-10-24T11:00:00Z", 1, 0},
		{"the last second of the window", "2026-10-25T10:59:59Z", 1, 0},
		{"just before the window is the usual", "2026-10-24T10:59:59Z", 0, 1},
		{"the first instant of the usual", "2026-10-17T11:00:00Z", 0, 1},
		{"at the end of the window: neither", "2026-10-25T11:00:00Z", 0, 0},
		{"long before: neither", "2026-10-01T11:00:00Z", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := newSpendWorld(t, spendNow)
			w.agent(spA, agenttypes.Claude, "Solo", "folder", "")
			w.usage(spA, agenttypes.Claude, "Solo", c.at, 1, 0, 0, 0)
			code, out := w.get("?range=24h")
			require.Equal(t, http.StatusOK, code, "%v", out)
			tokens := out["tokens"].(map[string]any)
			assert.EqualValues(t, c.window, tokens["window"].(map[string]any)["input"], "window")
			assert.EqualValues(t, c.usual, tokens["usual"].(map[string]any)["input"], "usual")
		})
	}
}

func TestSpendCacheWriteIsNullUntilSomeAgentReportsOne(t *testing.T) {
	cases := []struct {
		name         string
		window, usua int
		wantWindow   any
		wantUsual    any
	}{
		{"none reported", 0, 0, nil, nil},
		{"reported in the window", 5, 0, float64(5), float64(0)},
		{"reported only in the usual: the window says 0, not null", 0, 7, float64(0), float64(7)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := newSpendWorld(t, spendNow)
			w.agent(spA, agenttypes.Claude, "Solo", "folder", "")
			w.usage(spA, agenttypes.Claude, "Solo", "2026-10-25T09:10:00Z", 1, 1, 0, c.window)
			w.usage(spA, agenttypes.Claude, "Solo", "2026-10-20T09:10:00Z", 1, 1, 0, c.usua)
			code, out := w.get("")
			require.Equal(t, http.StatusOK, code, "%v", out)
			tokens := out["tokens"].(map[string]any)
			assert.Equal(t, c.wantWindow, tokens["window"].(map[string]any)["cache_write"])
			assert.Equal(t, c.wantUsual, tokens["usual"].(map[string]any)["cache_write"])
			point := out["per_hour"].([]any)[0].(map[string]any)
			if c.wantWindow == nil {
				assert.Nil(t, point["cache_write"], "the series follows")
			} else {
				assert.NotNil(t, point["cache_write"])
			}
		})
	}
}

func TestSpendAnAgentIsNamedByItsDisplayNameThenItsFolderThenItsRoleThenAgent(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Shown Name", "folder-a", "")
	w.agent(spB, agenttypes.Claude, "", "folder-b", "")
	w.agent(spC, agenttypes.Claude, "", "", "")
	w.member("Role C", agenttypes.Claude, spC, false)
	w.agent(spD, agenttypes.Claude, "", "", "")
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	byID := map[string]map[string]any{}
	for _, a := range agentsOf(out) {
		byID[a["session_id"].(string)] = a
	}
	assert.Equal(t, "Shown Name", byID[spA]["name"], "the display name wins over the folder")
	assert.Equal(t, "folder-b", byID[spB]["name"], "no display name: the folder")
	assert.Equal(t, "Role C", byID[spC]["name"], "no display name and no folder: its role on the board")
	assert.Equal(t, "Role C", byID[spC]["role"])
	assert.Equal(t, "Agent", byID[spD]["name"], "nothing to call it: Agent")
}

func TestSpendAnOrchestratorIsTheMemberWithTheOrchestratorFlag(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Plans", "folder-a", "")
	w.member("Orchestrator", agenttypes.Claude, spA, true)
	w.agent(spB, agenttypes.Codex, "Works", "folder-b", "")
	w.member("Backend Dev", agenttypes.Codex, spB, false)
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.Equal(t, true, agentNamed(t, out, "Plans")["orchestrator"])
	assert.Equal(t, "Orchestrator", agentNamed(t, out, "Plans")["role"])
	assert.Equal(t, false, agentNamed(t, out, "Works")["orchestrator"])
	assert.Equal(t, "Backend Dev", agentNamed(t, out, "Works")["role"])
}

func TestSpendACommitFindsItsAuthorByDisplayNameRoleOrFolderIgnoringCaseAndSpaces(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Display Dev", "folder-a", "")
	w.member("Role Dev", agenttypes.Claude, spA, false)
	w.agent(spB, agenttypes.Codex, "Other Dev", "other-folder", "")
	for i, c := range []struct{ author, file string }{
		{"display dev", "1.txt"},  // the display name, any case
		{"Role Dev", "2.txt"},     // the role on the board
		{"  FOLDER-A  ", "3.txt"}, // the folder, with spaces
		{"Other Dev", "4.txt"},    // another agent's
		{"Stranger", "5.txt"},     // nobody's
	} {
		spendCommit(t, w.repo, c.author, "2026-10-25T09:0"+string(rune('0'+i))+":00Z", c.file)
	}
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	commits := out["commits"].(map[string]any)
	assert.Equal(t, true, commits["available"])
	assert.EqualValues(t, 5, commits["window"])
	assert.EqualValues(t, 1, commits["unattributed"])
	assert.EqualValues(t, 3, agentNamed(t, out, "Display Dev")["commits"], "by display name, by role and by folder")
	assert.EqualValues(t, 1, agentNamed(t, out, "Other Dev")["commits"])
	assert.EqualValues(t, 1, agentNamed(t, out, "Unattributed")["commits"], "a commit that matches no agent is Unattributed")
}

func TestSpendSharesAndTheOrderOfTheAgents(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Small", "folder-a", "")
	w.agent(spB, agenttypes.Claude, "Big", "folder-b", "")
	w.agent(spC, agenttypes.Gemini, "Unmeasured", "folder-c", "")
	w.agent(spD, agenttypes.Claude, "Idle", "folder-d", "") // measured, no usage
	w.usage(spA, agenttypes.Claude, "Small", "2026-10-25T09:10:00Z", 100, 0, 0, 0)
	w.usage(spB, agenttypes.Claude, "Big", "2026-10-25T09:20:00Z", 300, 0, 0, 0)
	spendCommit(t, w.repo, "Stranger", "2026-10-25T09:30:00Z", "x.txt")
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	var names []string
	for _, a := range agentsOf(out) {
		names = append(names, a["name"].(string))
	}
	assert.Equal(t, []string{"Big", "Small", "Idle", "Unmeasured", "Unattributed"}, names, "measured agents by tokens, most first; then the rest in the order they were found; Unattributed last")
	assert.InDelta(t, 0.75, agentNamed(t, out, "Big")["share"], 0.0001)
	assert.InDelta(t, 0.25, agentNamed(t, out, "Small")["share"], 0.0001)
	assert.EqualValues(t, 0, agentNamed(t, out, "Idle")["tokens"], "a measured agent with no usage has 0, not null")
	assert.EqualValues(t, 0, agentNamed(t, out, "Idle")["share"])
	assert.Nil(t, agentNamed(t, out, "Unmeasured")["share"])
}

func TestSpendNoUsageAtAllMeansSharesOfZeroNotAFailure(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Quiet", "folder-a", "")
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "a share of 0/0 must not break the reply: %v", out)
	assert.EqualValues(t, 0, agentNamed(t, out, "Quiet")["share"])
	assert.EqualValues(t, 0, agentNamed(t, out, "Quiet")["tokens"])
}

func TestSpendAnEndedAgentWithTokensInTheWindowIsListedBesideTheLiveOnes(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Live", "folder-a", "")
	w.usage(spA, agenttypes.Claude, "Live", "2026-10-25T09:10:00Z", 10, 0, 0, 0)
	w.usage(spB, agenttypes.Codex, "Gone", "2026-10-25T09:20:00Z", 50, 0, 0, 0) // no live session
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, out["of_agents"])
	assert.EqualValues(t, 2, out["measured_agents"])
	var ended map[string]any
	for _, a := range agentsOf(out) {
		if a["session_id"] == spB {
			ended = a
		}
	}
	require.NotNil(t, ended, "the ended agent is listed")
	assert.Equal(t, "Agent", ended["name"], "an ended agent has no folder to call it by")
	assert.Equal(t, agenttypes.Codex, ended["agent_type"])
	assert.EqualValues(t, 50, ended["tokens"])
	assert.Equal(t, "Agent", agentsOf(out)[0]["name"], "most tokens first")
}

func TestSpendTaskTimesAreSummedByWhoCompletedThemAndWhatNoAgentCompletedIsKept(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Backend Dev", "folder-a", "")
	w.taskDone("Backend Dev", "2026-10-25T09:00:00Z")
	w.taskDone("backend dev", "2026-10-25T09:30:00Z") // the same person, another spelling
	w.taskDone("Operator", "2026-10-25T09:40:00Z")    // nobody on the board's agent list
	w.taskDone("", "2026-10-25T09:50:00Z")            // blank: counted in the totals, not listed
	w.taskDone("Backend Dev", "2026-10-20T09:00:00Z") // the usual
	code, out := w.get("")
	require.Equal(t, http.StatusOK, code, "%v", out)
	assert.EqualValues(t, 2, agentNamed(t, out, "Backend Dev")["tasks_done"], "two spellings, one agent")
	tt := out["task_time"].(map[string]any)
	assert.EqualValues(t, 4, tt["window"].(map[string]any)["done"])
	assert.EqualValues(t, 1, tt["usual"].(map[string]any)["done"])
	var listed [][2]any
	for _, a := range tt["agents"].([]any) {
		m := a.(map[string]any)
		listed = append(listed, [2]any{m["name"], m["done"]})
	}
	assert.Equal(t, [][2]any{{"Backend Dev", float64(2)}, {"Operator", float64(1)}}, listed, "most done first; the first spelling seen names it; the blank completer is not listed")
	days := tt["per_day"].([]any)
	assert.EqualValues(t, 4, days[6].(map[string]any)["done"], "today's four")
}

func TestSpendTheWindowFollowsTheClock(t *testing.T) {
	cases := []struct {
		name, rng, now, start, end string
		hours                      int
	}{
		{"24h on the hour", "24h", "2026-10-25T10:00:00Z", "2026-10-24T11:00:00Z", "2026-10-25T11:00:00Z", 24},
		{"24h just before the hour", "24h", "2026-10-25T10:59:59Z", "2026-10-24T11:00:00Z", "2026-10-25T11:00:00Z", 24},
		{"24h across midnight", "24h", "2026-10-25T23:30:00Z", "2026-10-25T00:00:00Z", "2026-10-26T00:00:00Z", 24},
		{"7d mid-day", "7d", "2026-10-25T10:30:00Z", "2026-10-19T00:00:00Z", "2026-10-26T00:00:00Z", 168},
		{"7d on midnight", "7d", "2026-10-26T00:00:00Z", "2026-10-20T00:00:00Z", "2026-10-27T00:00:00Z", 168},
		{"7d across a month", "7d", "2026-11-02T08:00:00Z", "2026-10-27T00:00:00Z", "2026-11-03T00:00:00Z", 168},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, c.now)
			require.NoError(t, err)
			w := newSpendWorld(t, now)
			code, out := w.get("?range=" + c.rng)
			require.Equal(t, http.StatusOK, code, "%v", out)
			assert.Equal(t, c.start, out["window_start"])
			assert.Equal(t, c.end, out["window_end"])
			assert.EqualValues(t, c.hours, out["range_hours"])
			assert.Equal(t, c.now, out["generated_at"])
			if c.rng == "24h" {
				assert.Len(t, out["per_hour"].([]any), 24)
				assert.NotContains(t, out, "range_days")
			} else {
				assert.NotContains(t, out, "per_hour")
			}
			assert.Len(t, out["per_day"].([]any), 7)
		})
	}
}

func TestSpendAnUnreadableBoardOfAgentsIsAnErrorInWords(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	require.NoError(t, w.db.Close())
	code, out := w.get("")
	assert.Equal(t, http.StatusInternalServerError, code)
	assert.Equal(t, "could not read the board's agents", out["error"])
}

// #8241: two cases the first mutation run left alive. One agent with a tool source is enough for the tool-call measures to be answered (not null); and the 7 d view's day is the sum of its 24 hours,
// hour 23 included.
func TestSpendOneAgentWithAToolSourceIsEnoughForTheToolCalls(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Only source", "folder-a", "")
	w.agent(spB, agenttypes.Gemini, "No source", "folder-b", "")
	w.toolUse(spA, "Only source", "2026-10-25T09:11:00+00:00")
	w.toolUse(spA, "Only source", "2026-10-25T09:12:00+00:00")
	w.toolUse(spA, "Only source", "2026-10-20T09:12:00+00:00") // the usual
	code, out := w.get("?range=24h")
	require.Equal(t, http.StatusOK, code, "%v", out)
	tools := out["tool_calls"].(map[string]any)
	assert.EqualValues(t, 1, tools["measured_agents"], "exactly one agent has a source")
	assert.EqualValues(t, 2, tools["of_agents"])
	assert.EqualValues(t, 2, tools["window"], "answered, not null, with one measured agent")
	assert.EqualValues(t, 1, tools["usual"])
	nine := out["per_hour"].([]any)[22].(map[string]any) // 2026-10-25T09:00Z is the 23rd hour of the window starting 2026-10-24T11:00Z
	assert.Equal(t, "2026-10-25T09:00:00Z", nine["hour"])
	assert.EqualValues(t, 2, nine["tool_calls"], "the hourly points follow")
	assert.EqualValues(t, 2, agentNamed(t, out, "Only source")["tool_calls"])
}

func TestSpendADayOfTheSevenDayViewSumsAllItsHoursTheLastIncluded(t *testing.T) {
	w := newSpendWorld(t, spendNow)
	w.agent(spA, agenttypes.Claude, "Late worker", "folder-a", "")
	w.usage(spA, agenttypes.Claude, "Late worker", "2026-10-24T23:30:00Z", 70, 7, 0, 0) // hour 23 of the 24th
	w.toolUse(spA, "Late worker", "2026-10-24T23:40:00+00:00")
	w.usage(spA, agenttypes.Claude, "Late worker", "2026-10-24T00:10:00Z", 3, 0, 0, 0) // hour 0 of the 24th
	code, out := w.get("?range=7d")
	require.Equal(t, http.StatusOK, code, "%v", out)
	var day map[string]any
	for _, d := range out["per_day"].([]any) {
		if d.(map[string]any)["day"] == "2026-10-24" {
			day = d.(map[string]any)
		}
	}
	require.NotNil(t, day, "the 24th is one of the seven days")
	assert.EqualValues(t, 70+7+3, day["tokens"], "hour 0 and hour 23 are both in the day")
	assert.EqualValues(t, 1, day["tool_calls"], "a tool call at 23:40 is in its day")
	assert.EqualValues(t, 70+7+3, out["tokens"].(map[string]any)["window"].(map[string]any)["input"].(float64)+out["tokens"].(map[string]any)["window"].(map[string]any)["output"].(float64), "the window total agrees with the days")
}
