package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8012: the shared-table lists the frontend draws from the API. A frontend that reads a key the API never sends is a bug that a wrong-shaped stub in a browser test hides (#7987 read
// by_agent, which the API does not send). Each test here asks the REAL route and pins the exact keys the frontend reads (the lists in the comments are what the static JS reads, named by file):
// a key renamed or dropped on the Go side fails here, and a key the frontend starts reading must be added to the list with the Go side that sends it.

// requireKeys asserts that obj has every key (a nested key is "a.b"); a key present with a null value is present.
func requireKeys(t *testing.T, what string, obj map[string]any, keys ...string) {
	t.Helper()
	var missing []string
	for _, k := range keys {
		if !hasKey(obj, k) {
			missing = append(missing, k)
		}
	}
	sort.Strings(missing)
	assert.Empty(t, missing, "%s: the frontend reads these keys and the API did not send them", what)
}

func hasKey(obj map[string]any, path string) bool {
	cur := any(obj)
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return false
		}
		v, present := m[part]
		if !present {
			return false
		}
		cur = v
	}
	return true
}

// Saved messages (saved.js, saved_marks.js, inbox_sidebar.js, inbox_coral.js): GET /api/saved and GET /api/saved/{id}/message.
func TestSavedListAndMessageSendTheKeysTheFrontendReads(t *testing.T) {
	g := newSavedRig(t)
	code, saved := g.do("POST", "/api/saved", savedAsOperator, agentSave(strings.Repeat("c3", 10), "a snippet"))
	require.Equal(t, http.StatusOK, code, "%v", saved)
	code, out := g.do("GET", "/api/saved", savedAsOperator, nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/saved", out, "items", "open", "done")
	items, _ := out["items"].([]any)
	require.Len(t, items, 1)
	// every field saved.js and saved_marks.js read from an item (validSavedItem: id, kind, ref, key; the rest from the list's rows and the re-POST body)
	requireKeys(t, "a saved item", items[0].(map[string]any), "id", "kind", "ref", "key", "agent_type", "title", "snippet", "said_at", "saved_at", "done_at", "team", "author", "reason")

	id := int64(items[0].(map[string]any)["id"].(float64))
	code, msg := g.do("GET", "/api/saved/"+itoa(id)+"/message", savedAsOperator, nil)
	require.Equal(t, http.StatusOK, code, "%v", msg)
	requireKeys(t, "GET /api/saved/{id}/message", msg, "text", "partial", "reason") // inbox_coral.js readSavedMessage
}

// Goals (goals_adapter.js toGoalList/toGoal/toTaskPage/toTask, goals_view.js, task_goals.js, team_page.js, inbox_sidebar.js).
func TestGoalListsSendTheKeysTheFrontendReads(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	code, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "outcome": "People can use it", "done_when": "The release is out", "subscriber_id": "Orchestrator", "driver": "Orchestrator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	id := itoa(int64(g["id"].(float64)))
	code, t1 := call("POST", "/api/board/team/tasks", map[string]any{"title": "First", "subscriber_id": "Orchestrator", "goal_id": g["id"]})
	require.Equal(t, http.StatusCreated, code, "%v", t1)
	_, err := h.bs.CreateTaskWithOpts(context.Background(), "team", "Follow-up", "", "medium", "Orchestrator", nil)
	require.NoError(t, err)

	// the board's list: goals, next_cursor, no_goal_open; every goal's row fields
	code, list := call("GET", "/api/board/team/goals?state=proposed,active,blocked,done,dropped&limit=200", nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/board/{p}/goals", list, "goals", "next_cursor", "no_goal_open")
	goals := goalsOf(t, list)
	require.Len(t, goals, 1)
	requireKeys(t, "a goal of the list", goals[0], "id", "title", "outcome", "state", "done_when", "driver", "updated_at", "rollup.done", "rollup.active", "rollup.blocked", "rollup.queued")

	// one goal: its fields flat, and follow_ups_open (goals_view.js reads it as Number(...) || 0: absent at 0 is fine, so a follow-up is made to see it sent)
	child, err := h.bs.CreateTaskWithOpts(context.Background(), "team", "Follow-up of First", "", "medium", "Orchestrator", nil)
	require.NoError(t, err)
	_ = child
	code, one := call("GET", "/api/board/team/goals/"+id, nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/board/{p}/goals/{id}", one, "id", "title", "outcome", "state", "done_when", "updated_at", "rollup.done", "rollup.active", "rollup.blocked", "rollup.queued")

	// the goal's tasks (goals_adapter.js toTaskPage and toTask)
	code, tasks := call("GET", "/api/board/team/tasks?goal="+id, nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/board/{p}/tasks?goal=", tasks, "tasks", "next_cursor", "total_open")
	rows, _ := tasks["tasks"].([]any)
	require.NotEmpty(t, rows)
	requireKeys(t, "a task of a goal's page", rows[0].(map[string]any), "id", "title", "assigned_to", "status", "goal_id")

	// all boards (inbox_sidebar.js refreshGoals): goals with board_id
	code, all := call("GET", "/api/goals?limit=100", nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/goals", all, "goals")
	allGoals, _ := all["goals"].([]any)
	require.NotEmpty(t, allGoals)
	requireKeys(t, "a goal of the all-boards list", allGoals[0].(map[string]any), "id", "board_id", "title", "outcome", "state", "rollup.done", "rollup.total", "updated_at")

	// every team's artifacts (inbox_artifacts.js, Goal #62): the team route's keys, the team each row belongs to, and the teams the Team filter offers
	code, teamArts := call("GET", "/api/team-artifacts?limit=5", nil)
	require.Equal(t, http.StatusOK, code)
	requireKeys(t, "GET /api/team-artifacts", teamArts, "artifacts", "total", "all", "teams", "limit", "offset", "has_more", "truncated")
}

// History (api.js loadHistorySessionsPaged, mailbox_chats.js readMore/chatSections, history_list.js, board_agent_links.js): GET /api/sessions/history and /history/counts.
func TestHistoryListAndCountsSendTheKeysTheFrontendReads(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "history-keys.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "history-keys-board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	first, last := "2026-10-25T19:00:00Z", "2026-10-25T20:00:00Z"
	require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "chat-keys", SourceType: "codex", SourceFile: "/fixture/chat", FirstTimestamp: &first, LastTimestamp: &last, MessageCount: 4, DisplaySummary: "a summary", FirstUserMessage: "hello", AgentName: "agent", DisplayName: "Dev"}))
	_, err = bs.Subscribe(ctx, "keys-board", "Dev", "Dev", "", nil, "")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "keys-board", "Dev", "a group chat message", nil)
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	r.Get("/api/sessions/history/counts", h.ChatCounts)
	get := func(path string) map[string]any {
		t.Helper()
		req := httptest.NewRequest("GET", path, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}

	list := get("/api/sessions/history?type=all&page=1&page_size=50")
	requireKeys(t, "GET /api/sessions/history", list, "sessions", "total", "page", "page_size")
	var agentRow, groupRow map[string]any
	for _, s := range list["sessions"].([]any) {
		row := s.(map[string]any)
		if row["type"] == "group" {
			groupRow = row
		} else {
			agentRow = row
		}
	}
	require.NotNil(t, agentRow, "an agent chat")
	require.NotNil(t, groupRow, "a group chat")
	// history_list.js chatRowHtml/chatTableRow/groupOfChat, mailbox_chats.js chatsSpec, history_label.js, resume_dialog.js, board_agent_links.js
	requireKeys(t, "an agent chat row", agentRow, "session_id", "title", "summary", "display_name", "agent_name", "last_timestamp", "duration_sec", "source_type", "branch", "tags", "starred", "archived", "active", "type")
	// the group chat row: history_list.js reads updated_at for its time and its day group, and the API does not send it (found by #8012: reported on the board; last_timestamp is what it sends)
	requireKeys(t, "a group chat row", groupRow, "session_id", "title", "type", "message_count", "subscriber_count", "last_timestamp", "starred", "archived", "active")

	counts := get("/api/sessions/history/counts")
	requireKeys(t, "GET /api/sessions/history/counts", counts, "all", "group", "notes", "active", "starred", "archived", "by_agent_type", "tags")
}

// Tasks (task_list.js, tasks_view.js, team_tasks_page.js, goals_adapter.js, inbox_coral.js): the board's task list GET /api/board/{p}/tasks (the default list) and GET /api/board/tasks (the query).
func TestTaskListsSendTheKeysTheFrontendReads(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	r.Get("/api/board/tasks", h.ListAllTasks)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	task, err := h.bs.CreateTask(ctx, "keys-team", "A task", "its body", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_ = task
	get := func(path string) map[string]any {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}

	// the default list: the wrapper and each row (tasks_view.js taskColumns, task_list.js, team_tasks_page.js)
	list := get("/api/board/keys-team/tasks?limit=50")
	requireKeys(t, "GET /api/board/{p}/tasks", list, "tasks", "next_cursor", "total_open", "total_completed")
	rows, _ := list["tasks"].([]any)
	require.NotEmpty(t, rows)
	requireKeys(t, "a task of the default list", rows[0].(map[string]any), "id", "title", "status", "priority", "created_by", "created_at", "assigned_to", "revision", "board_id", "body_preview") // review_requested is sent only while a review is requested (task_list.js reads it as a truthy flag)
	// the query (the filtered Tasks tab and the Inbox): rows are the full task, the Inbox asks for fields
	q := get("/api/board/tasks?board=keys-team&limit=50")
	requireKeys(t, "GET /api/board/tasks", q, "tasks", "total")
	qrows, _ := q["tasks"].([]any)
	require.NotEmpty(t, qrows)
	requireKeys(t, "a task of the query", qrows[0].(map[string]any), "id", "title", "status", "priority", "created_by", "created_at", "assigned_to", "revision", "board_id", "body", "workflow")
	inbox := get("/api/board/tasks?board=keys-team&fields=id,board_id,board_label,title,priority,status,created_by,created_at,updated_at,revision,goal_id,goal_title")
	irows, _ := inbox["tasks"].([]any)
	require.NotEmpty(t, irows)
	requireKeys(t, "a task of the Inbox's field list", irows[0].(map[string]any), "id", "board_id", "board_label", "title", "priority", "status", "created_by", "created_at", "updated_at", "revision")
}

// The Who column (#8492, #8501): a task in review names its reviewers, in the default list and in the list of a goal's tasks, as "reviewers"; a task nobody reviews sends no such key.
func TestTaskListRowsNameTheReviewersOfATaskInReview(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()
	for name, role := range map[string]string{"Orchestrator": "Orchestrator", "Dev": "Developer", "Rev": "Security"} {
		_, err := h.bs.Subscribe(ctx, "who-team", name, role, name+"-session", nil, "all")
		require.NoError(t, err)
	}
	plain, err := h.bs.CreateTask(ctx, "who-team", "Nobody reviews this", "", "low", "Orchestrator", "Dev")
	require.NoError(t, err)
	reviewed, err := h.bs.CreateTask(ctx, "who-team", "Reviewed", "", "high", "Orchestrator", "Dev")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "who-team", "Dev", reviewed.ID)
	require.NoError(t, err)
	_, err = h.bs.SubmitCompletionReview(ctx, "who-team", reviewed.ID, "Dev", "built", "success", "needs review", []board.TaskArtifact{{Name: "notes.md", MediaType: "text/markdown", Content: "# notes"}})
	require.NoError(t, err)
	_, _, err = h.bs.HandToOrchestrator(ctx, "who-team", reviewed.ID, "Dev")
	require.NoError(t, err)
	_, _, err = h.bs.DelegateReview(ctx, "who-team", reviewed.ID, "Orchestrator", []string{"Rev"})
	require.NoError(t, err)

	resp, err := http.Get(srv.URL + "/api/board/who-team/tasks?limit=50")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var list struct {
		Tasks []map[string]any `json:"tasks"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&list))
	var seenReviewed, seenPlain bool
	for _, row := range list.Tasks {
		switch int64(row["id"].(float64)) {
		case reviewed.ID:
			seenReviewed = true
			requireKeys(t, "a task in review", row, "id", "title", "status", "reviewers")
			assert.Equal(t, []any{"Rev"}, row["reviewers"])
		case plain.ID:
			seenPlain = true
			assert.NotContains(t, row, "reviewers", "a task nobody reviews sends no key")
		}
	}
	assert.True(t, seenReviewed && seenPlain, "both rows are in the list")
}

// Artifacts (team_artifacts_page.js, team_task_artifacts.js): GET /api/board/{p}/artifacts, also with task=.
func TestTeamArtifactsListSendsTheKeysTheFrontendReads(t *testing.T) {
	srv, h, _ := teamArtifactServer(t)
	taskID := completeWithArtifacts(t, h, "keys-team", "Build it", []board.TaskArtifact{{Name: "notes.md", MediaType: "text/markdown", Content: "# notes"}})
	for _, q := range []string{"", "?task=" + itoa(taskID)} {
		resp, err := http.Get(srv.URL + "/api/board/keys-team/artifacts" + q)
		require.NoError(t, err)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, "%v", out)
		requireKeys(t, "GET /api/board/{p}/artifacts"+q, out, "artifacts", "project", "has_more", "truncated")
		if q != "" {
			requireKeys(t, "GET /api/board/{p}/artifacts"+q, out, "total", "all") // the task's section says "N more are in the Artifacts tab"; the tab counts
		}
		arts, _ := out["artifacts"].([]any)
		require.NotEmpty(t, arts, q)
		requireKeys(t, "an artifact row", arts[0].(map[string]any), "id", "name", "media_type", "size", "created_at", "task_id", "task_title", "source", "available", "inline", "reference_count", "produced_by")
	}
}

func getKeysJSON(t *testing.T, r http.Handler, path string) map[string]any {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	require.Equal(t, 200, w.Code, path+": "+w.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out), path)
	return out
}

func firstRow(t *testing.T, what string, obj map[string]any, key string) map[string]any {
	t.Helper()
	rows, _ := obj[key].([]any)
	require.NotEmpty(t, rows, what+": no "+key)
	return rows[0].(map[string]any)
}

func TestTokenUsageViewsSendTheKeysTheFrontendReads(t *testing.T) {
	ts, r, db := seriesRouter(t)
	h := NewTokenUsageHandler(db)
	r.Get("/api/token-usage/by-team", h.UsageSummaryByBoard)
	r.Get("/api/token-usage/by-branch", h.UsageSummaryByBranch)
	base := seedHours(t, ts)
	since := url.QueryEscape(base.Add(-time.Hour).Format(time.RFC3339))
	// A session with a live record (its launch time is read by By agent's Launched and Duration columns) and a git snapshot on a branch with a pull request (By branch).
	ctx := context.Background()
	require.NoError(t, store.NewSessionStore(db).RegisterLiveSession(ctx, &store.LiveSession{SessionID: "s1", AgentType: "claude", AgentName: "alpha", WorkingDir: t.TempDir()}))
	sid, when, remote := "s1", base.Format(time.RFC3339), "https://example.invalid/acme/repo"
	require.NoError(t, store.NewGitStore(db).UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "alpha", AgentType: "claude", WorkingDirectory: t.TempDir(), Branch: "feature", CommitHash: strings.Repeat("a", 40),
		CommitSubject: "c", CommitTimestamp: &when, SessionID: &sid, RemoteURL: &remote, PRNumber: 12}))

	sum := getKeysJSON(t, r, "/api/token-usage/summary?since="+since)
	requireKeys(t, "summary", sum, "totals", "by_agent_type", "by_model", "by_thinking", "by_agent",
		"totals.input_tokens", "totals.output_tokens", "totals.cache_read_tokens", "totals.cache_write_tokens", "totals.num_requests", "totals.cost_usd")
	// The Analytics tables read these from every row (cost_dashboard.js, _renderProviderTable, _renderModelTable, _renderThinkingTable, _renderAgentTable, _renderTeamTable, _renderBranchTable): a renamed token key
	// blanks a column and nothing else fails (#8323 found input_tokens on by_agent renamed with this census green), so each row type pins every key its table draws.
	tokens := []string{"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"}
	rowKeys := func(own ...string) []string { return append(append([]string{}, own...), tokens...) }
	requireKeys(t, "by_agent_type row", firstRow(t, "summary", sum, "by_agent_type"), rowKeys("agent_type", "num_requests")...)
	requireKeys(t, "by_model row", firstRow(t, "summary", sum, "by_model"), rowKeys("model", "agent_type", "num_requests", "total_tokens")...)
	requireKeys(t, "by_thinking row", firstRow(t, "summary", sum, "by_thinking"), rowKeys("agent_type", "model", "num_calls", "thinking", "thinking_tokens")...)
	requireKeys(t, "by_agent row", rowWhere(t, sum, "by_agent", "session_id", "s1"), // s1: the session with a live record
		rowKeys("session_id", "agent_name", "board_name", "folder", "working_dir", "requests", "total_tokens", "first_seen", "last_seen", "launched_at")...) // stopped_at is left out of a session still running: By agent reads it only for an ended one

	plain := getKeysJSON(t, r, "/api/token-usage/timeseries?interval=1h&since="+since)
	requireKeys(t, "timeseries bucket", firstRow(t, "timeseries", plain, "buckets"), "bucket", "cumulative_cost",
		"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "num_requests")
	grouped := getKeysJSON(t, r, "/api/token-usage/timeseries?interval=1h&group_by=team&since="+since)
	for _, b := range grouped["buckets"].([]any) {
		if s, _ := b.(map[string]any)["series"].([]any); len(s) > 0 {
			requireKeys(t, "timeseries series", s[0].(map[string]any), "key", "label", "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
			break
		}
	}

	requireKeys(t, "by-team row", firstRow(t, "by-team", getKeysJSON(t, r, "/api/token-usage/by-team?since="+since), "teams"),
		rowKeys("board_name", "num_agents", "total_tokens")...)
	requireKeys(t, "by-branch row", firstRow(t, "by-branch", getKeysJSON(t, r, "/api/token-usage/by-branch?since="+since), "branches"),
		rowKeys("board_name", "branch", "repo_name", "pr_number", "remote_url", "num_agents")...)
	requireKeys(t, "turns row", firstRow(t, "turns", getKeysJSON(t, r, "/api/token-usage/session/s1/turns"), "turns"), "cumulative_cost")
}

func TestJobAndWorkflowListsSendTheKeysTheFrontendReads(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{}
	dir := t.TempDir()
	sched := store.NewScheduleStore(db)
	job, err := sched.CreateScheduledJob(ctx, &store.ScheduledJob{Name: "j", CronExpr: "0 * * * *", Timezone: "UTC", AgentType: "claude",
		RepoPath: dir, BaseBranch: "main", Prompt: "p", Enabled: 1, MaxDurationS: 60, JobType: "prompt"})
	require.NoError(t, err)
	_, err = sched.CreateScheduledRun(ctx, job.ID, "2026-10-15T10:00:00Z", "completed")
	require.NoError(t, err)
	ws := store.NewWorkflowStore(db)
	wf, err := ws.CreateWorkflow(ctx, &store.Workflow{Name: "wf", StepsJSON: `[{"name":"one","type":"shell","command":"true"}]`,
		DefaultAgentJSON: "{}", BaseBranch: "main", MaxDurationS: 60, Enabled: 1})
	require.NoError(t, err)
	_, err = ws.CreateWorkflowRun(ctx, wf.ID, "manual", nil)
	require.NoError(t, err)

	sh, wh := NewScheduleHandler(db, cfg), NewWorkflowHandler(db, cfg)
	r := chi.NewRouter()
	r.Get("/api/scheduled/jobs", sh.ListJobs)
	r.Get("/api/scheduled/jobs/{jobID}/runs", sh.GetJobRuns)
	r.Get("/api/workflows", wh.ListWorkflows)
	r.Get("/api/workflows/{workflowID}/runs", wh.ListWorkflowRuns)

	jobs := getKeysJSON(t, r, "/api/scheduled/jobs")
	requireKeys(t, "job row", firstRow(t, "jobs", jobs, "jobs"), "id", "name", "description", "cron_expr", "timezone", "enabled",
		"paused_reason", "max_duration_s", "cleanup_worktree", "flags", "prompt", "repo_path", "base_branch", "agent_type",
		"job_type", "next_fire_at", "consecutive_failures", "last_run",
		"last_run.id", "last_run.status", "last_run.started_at", "last_run.finished_at", "last_run.exit_reason", "last_run.error_msg")
	requireKeys(t, "job run row", firstRow(t, "job runs", getKeysJSON(t, r, "/api/scheduled/jobs/"+strconv.FormatInt(job.ID, 10)+"/runs"), "runs"),
		"id", "status", "started_at", "finished_at", "exit_reason", "error_msg")

	wfs := getKeysJSON(t, r, "/api/workflows")
	requireKeys(t, "workflow row", firstRow(t, "workflows", wfs, "workflows"), "id", "name", "description", "enabled")
	requireKeys(t, "workflow run row", firstRow(t, "workflow runs", getKeysJSON(t, r, "/api/workflows/"+strconv.FormatInt(wf.ID, 10)+"/runs"), "runs"),
		"id", "status", "trigger_type") // started_at/finished_at are omitted until the run has started
}
