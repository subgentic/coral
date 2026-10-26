package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #8325 (goal #36 gap 2 of #8323): the four lists the census of #8012 did not reach, each asked of the REAL route and pinned to the keys the static JS reads, named by file. A key renamed or dropped on the Go
// side fails here; a key the frontend starts reading must be added with the Go side that sends it.

// The team Agents tab and the team header's "N need attention": GET /api/board/{team}/status (team_agents_page.js, team_page.js drawStatus, team_availability.js).
func TestTeamAgentsTabStatusSendsTheKeysTheFrontendReads(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "keys-team"
	ids := map[string]string{}
	for _, name := range []string{"busy", "input", "offline"} {
		sid := uuid.NewString()
		ids[name] = sid
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
		_, err := h.bs.Subscribe(ctx, team, name, "Developer", "claude-"+sid, nil, "all")
		require.NoError(t, err)
		if name != "offline" {
			terminal.addSession("claude-"+sid, "/tmp")
		}
		if name == "input" {
			_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: "notification", Summary: "Claude needs your approval"})
			require.NoError(t, err)
		}
	}
	_, err := h.bs.CreateTask(ctx, team, "Board implementation", "", "high", "lead", "busy")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, team, "busy")
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/status", h.TeamAvailability)
	body := decodeListBody(t, r, "/api/board/"+team+"/status")
	for name, availability := range map[string]string{"busy": "task_idle", "input": "needs_input", "offline": "offline"} {
		row := rowWhere(t, body, "agents", "name", name)
		requireKeys(t, "status row of "+name, row, "name", "subscriber_id", "session_id", "agent_type", "availability", "reason", "tasks")
		if name != "busy" { // busy may read busy or task_idle by the terminal's state; the others are fixed
			assert.Equal(t, availability, row["availability"], name)
		}
	}
	busy := rowWhere(t, body, "agents", "name", "busy")
	tasks, _ := busy["tasks"].([]any)
	require.NotEmpty(t, tasks, "the agent with a claimed task lists it")
	requireKeys(t, "status task", tasks[0].(map[string]any), "id", "status", "title")
}

// The team Knowledge list: GET /api/teams/detail/{team}/knowledge (team_knowledge_page.js reads exists, index, created_at and each agent's name and content).
func TestTeamKnowledgeListSendsTheKeysTheFrontendReads(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	dir := filepath.Join(h.cfg.CoralDir(), "agent_knowledge", "keys-team")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "index.md"), []byte("# Index\n\n- one\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "one.md"), []byte("# One\n\nwhat one learned\n"), 0o644))
	r := chi.NewRouter()
	r.Get("/api/teams/detail/{name}/knowledge", h.GetTeamKnowledge)
	body := decodeListBody(t, r, "/api/teams/detail/keys-team/knowledge")
	requireKeys(t, "knowledge", body, "exists", "index", "created_at", "agents")
	assert.Equal(t, true, body["exists"])
	requireKeys(t, "knowledge agent", firstRow(t, "knowledge", body, "agents"), "name", "content")
	assert.Equal(t, map[string]any{"exists": false}, decodeListBody(t, r, "/api/teams/detail/no-such-team/knowledge"), "a team with none says exists false and nothing else")
}

// The Inbox's Needs you rows: the live list's row of an agent waiting for input (inbox_sidebar.js, inbox_tab.js, display_activity_hint.js, session_state.js): who it is, what it asks, since when, on which team and folder.
func TestNeedsYouRowsSendTheKeysTheFrontendReads(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "keys-team"
	sid := uuid.NewString()
	name := "Asker"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "folder-asker", AgentType: "claude", BoardName: &team, WorkingDir: "/tmp/asker-folder", DisplayName: &name}))
	_, err := h.bs.Subscribe(ctx, team, "Asker", "Developer", "claude-"+sid, nil, "all")
	require.NoError(t, err)
	terminal.addSession("claude-"+sid, "/tmp/asker-folder")
	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "Asker", SessionID: &sid, EventType: "notification", Summary: "Claude needs your approval to run rm -rf build"})
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/sessions/live", h.List)
	rows, _ := decodeListRows(t, r, "/api/sessions/live")
	var row map[string]any
	for _, x := range rows {
		if x["session_id"] == sid {
			row = x
		}
	}
	require.NotNil(t, row, "the waiting agent is on the live list")
	requireKeys(t, "live row (Needs you)", row, "session_id", "name", "display_name", "agent_type", "board_project", "working_directory",
		"waiting_for_input", "waiting_summary", "waiting_since", "waiting_kind", "display_activity_hint")
	assert.Equal(t, true, row["waiting_for_input"])
}

// The Servers list: GET /api/servers (servers.js, server_rows.js): the hub's own row and each registered server.
func TestServersListSendsTheKeysTheFrontendReads(t *testing.T) {
	e := newRSEnv(t)
	rejectKeys.Store(false)
	t.Cleanup(func() { rejectKeys.Store(false) })
	remote := fakeRemote(t, routeSecret)
	require.Equal(t, 201, e.do("POST", "/api/servers", map[string]any{"id": "ws", "label": "Workstation", "url": remote.URL, "api_key": routeSecret, "allow_private": true}).Code)
	var rows []map[string]any
	decode(t, e.do("GET", "/api/servers", nil), &rows)
	var local, ws map[string]any
	for _, x := range rows {
		switch x["id"] {
		case "local":
			local = x
		case "ws":
			ws = x
		}
	}
	require.NotNil(t, local)
	require.NotNil(t, ws)
	requireKeys(t, "local server row", local, "id", "label", "status", "local")
	requireKeys(t, "server row", ws, "id", "label", "url", "status", "allow_private", "created_at", "last_seen", "last_error")
	assert.NotContains(t, ws, "api_key", "the key is never sent")
}

// decodeListRows asks a route that answers a JSON array (the live list) as the dashboard does.
func decodeListRows(t *testing.T, r http.Handler, path string) ([]map[string]any, int) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	r.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, path+": "+rec.Body.String())
	var out []map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), path)
	return out, rec.Code
}
