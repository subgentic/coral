package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
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

// The keys the dashboard's lists read that the API did not send (#8014, found by #8012's census): each is pinned on the real route.

func decodeListBody(t *testing.T, r http.Handler, path string) map[string]any {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, path+": "+rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), path)
	return out
}

func rowWhere(t *testing.T, body map[string]any, key, field string, want any) map[string]any {
	t.Helper()
	rows, _ := body[key].([]any)
	for _, r := range rows {
		if m := r.(map[string]any); m[field] == want {
			return m
		}
	}
	require.Failf(t, "no row", "%s has no row with %s=%v: %v", key, field, want, rows)
	return nil
}

func TestGroupChatRowsCarryUpdatedAtForTheirTimeAndDayGroup(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "b.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	_, err = bs.Subscribe(ctx, "keys-board", "Dev", "Dev", "", nil, "")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "keys-board", "Dev", "a group chat message", nil)
	require.NoError(t, err)
	h := NewHistoryHandler(db, &config.Config{}, bs)
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)

	row := rowWhere(t, decodeListBody(t, r, "/api/sessions/history?type=group&page=1&page_size=50"), "sessions", "type", "group")
	assert.NotEmpty(t, row["last_timestamp"])
	assert.Equal(t, row["last_timestamp"], row["updated_at"], "history_list.js shows a group chat's time and day from updated_at")
}

func TestTaskListsSendUpdatedAtAndVerification(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/tasks", h.ListTasks)
	r.Get("/api/board/tasks", h.ListAllTasks)
	ctx := context.Background()
	open, err := h.bs.CreateTask(ctx, "keys-team", "Open one", "", "medium", "Dev")
	require.NoError(t, err)
	done, err := h.bs.CreateTask(ctx, "keys-team", "Done one", "", "medium", "Dev")
	require.NoError(t, err)
	_, err = h.bs.CompleteTaskWithArtifacts(ctx, "keys-team", done.ID, "Dev", nil, "success", []board.TaskArtifact{{Name: "notes.md", MediaType: "text/markdown", Content: "# notes"}})
	require.NoError(t, err)

	check := func(what string, body map[string]any) {
		t.Helper()
		o, d := rowWhere(t, body, "tasks", "id", float64(open.ID)), rowWhere(t, body, "tasks", "id", float64(done.ID))
		assert.NotEmpty(t, o["updated_at"], what+": the Tasks tab's Updated column sorts and shows updated_at")
		assert.NotEmpty(t, d["updated_at"], what)
		assert.NotContains(t, o, "verification", what+": an open task has none")
		v, _ := d["verification"].(map[string]any)
		require.NotNil(t, v, what+": a finished task with evidence says so (the Evidence mark)")
		assert.Equal(t, "evidence", v["state"], what)
		assert.Equal(t, "success", d["outcome"], what)
		assert.NotEmpty(t, d["worked_by"], what)
	}
	check("the board's task list", decodeListBody(t, r, "/api/board/keys-team/tasks?status=all&limit=50"))
	check("the filtered query rows", decodeListBody(t, r, "/api/board/tasks?board=keys-team&limit=50"))
	check("the all-boards list", decodeListBody(t, r, "/api/board/tasks"))
}

func TestCostByAgentSaysWhetherTheSessionIsLive(t *testing.T) {
	ts, r, db := seriesRouter(t)
	seedHours(t, ts) // s1 and s2 have usage
	ls := store.NewSessionStore(db)
	require.NoError(t, ls.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "s1", AgentType: "claude", AgentName: "alpha", WorkingDir: t.TempDir()}))
	body := decodeListBody(t, r, "/api/token-usage/summary?since="+url.QueryEscape(time.Now().Add(-48*time.Hour).UTC().Format(time.RFC3339)))
	assert.Equal(t, true, rowWhere(t, body, "by_agent", "session_id", "s1")["is_live"], "a running session")
	assert.Equal(t, false, rowWhere(t, body, "by_agent", "session_id", "s2")["is_live"], "no session of this computer: the page says (ended)")
	require.NoError(t, ls.UnregisterLiveSession(context.Background(), "s1"))
	body = decodeListBody(t, r, "/api/token-usage/summary?since="+url.QueryEscape(time.Now().Add(-48*time.Hour).UTC().Format(time.RFC3339)))
	assert.Equal(t, false, rowWhere(t, body, "by_agent", "session_id", "s1")["is_live"], "a stopped session")
}

func TestWorkflowListSaysWhichStepFailedInTheLastRun(t *testing.T) {
	rig := newRunViewRig(t)
	rig.run("failed", []map[string]any{{"index": 0, "name": "build", "status": "completed"}, {"index": 1, "name": "test", "status": "failed", "error_tail": "boom"}},
		"2026-10-25T10:00:00Z", "2026-10-25T10:01:00Z", nil)
	rig.r.(*chi.Mux).Get("/api/workflows", rig.h.ListWorkflows)
	wf := rowWhere(t, decodeListBody(t, rig.r, "/api/workflows"), "workflows", "id", float64(rig.wf.ID))
	last, _ := wf["last_run"].(map[string]any)
	require.NotNil(t, last)
	step, _ := last["failed_step"].(map[string]any)
	require.NotNil(t, step, "workflows.js reads last_run.failed_step for 'step 2 (test)'")
	assert.Equal(t, float64(2), step["number"])
	assert.Equal(t, "test", step["name"])
	assert.Equal(t, "boom", last["failure_reason"])
}
