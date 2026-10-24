package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #7301: a waiting agent or task says which goal it serves. A live session row carries goal {id, title, board} from its session's in-progress task, null when there is none; the Inbox's task rows carry
// goal_title; and the goal is private to the Operator and the agent's own board.
func TestAddSessionGoalsGivesEachRowItsGoalOrNull(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	const sessA, sessB = "aaaaaaaa-0000-4000-8000-000000007301", "bbbbbbbb-0000-4000-8000-000000007301"
	sessDB, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { sessDB.Close() })
	ss := store.NewSessionStore(sessDB)
	for _, sid := range []string{sessA, sessB} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "worker", WorkingDir: t.TempDir()}))
	}
	h.bs.SetSessionsDB(sessDB.DB)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	subscribeSession(t, h, "team", "Worker A", sessA)
	subscribeSession(t, h, "team", "Worker B", sessB)
	call := goalCall(t, server.URL)
	code, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "subscriber_id": "Orchestrator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	gid := int64(g["id"].(float64))
	code, out := call("POST", "/api/board/team/tasks", map[string]any{"title": "with a goal", "created_by": "Orchestrator", "assigned_to": "Worker A", "goal_id": gid})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	code, out = call("POST", "/api/board/team/tasks", map[string]any{"title": "without a goal", "created_by": "Orchestrator", "assigned_to": "Worker B"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	for _, who := range []string{"Worker A", "Worker B"} {
		code, out = call("POST", "/api/board/team/tasks/claim", map[string]any{"subscriber_id": who})
		require.Equal(t, http.StatusOK, code, "%s: %v", who, out)
	}
	sh := &SessionsHandler{bs: h.bs}
	rows := []map[string]any{{"session_id": sessA}, {"session_id": sessB}, {"session_id": "sid-c"}, {"name": "no session id"}}
	sh.addSessionGoals(ctx, rows)
	assert.Equal(t, board.GoalRef{ID: gid, Title: "Ship the beta", Board: "team"}, rows[0]["goal"], "the in-progress task's goal")
	for _, i := range []int{1, 2, 3} {
		v, ok := rows[i]["goal"]
		assert.True(t, ok, "the key is there on every row: %v", rows[i])
		assert.Nil(t, v, "and null when there is no goal: %v", rows[i])
	}
	(&SessionsHandler{}).addSessionGoals(ctx, rows) // no board store: nothing breaks
}

func TestSessionGoalIsPrivateToTheOperatorAndTheAgentsBoard(t *testing.T) {
	rows := rosterRows()
	for _, r := range rows {
		r["goal"] = map[string]any{"id": 7, "title": "GOAL-" + r["name"].(string), "board": r["board_project"]}
	}
	got := scopeRowsForAgent(rows, "sid-me")
	for _, i := range []int{0, 1} {
		assert.Contains(t, got[i], "goal", "the agent's own row and its board mate's keep the goal")
	}
	for _, i := range []int{2, 3, 4} {
		assert.NotContains(t, got[i], "goal", "another board, no board and another server: no goal (an allow-list)")
	}
}

func TestInboxTaskRowsCarryTheGoalTitle(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	code, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ship the beta", "subscriber_id": "Orchestrator"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	gid := int64(g["id"].(float64))
	linked, err := h.bs.CreateTask(ctx, "team", "linked", "", "medium", "Orchestrator")
	require.NoError(t, err)
	require.NoError(t, h.bs.SetTaskGoal(ctx, "team", linked.ID, &gid))
	_, err = h.bs.CreateTask(ctx, "team", "loose", "", "medium", "Orchestrator")
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Get("/api/board/tasks", h.ListAllTasks)
	all := httptest.NewServer(r)
	t.Cleanup(all.Close)
	callAll := goalCall(t, all.URL)
	for _, path := range []string{"/api/board/tasks", "/api/board/tasks?status=pending&limit=20"} {
		code, out := callAll("GET", path, nil)
		require.Equal(t, 200, code, path)
		tasks, _ := out["tasks"].([]any)
		require.Len(t, tasks, 2, path)
		titles := map[string]any{}
		for _, raw := range tasks {
			tk := raw.(map[string]any)
			titles[tk["title"].(string)] = tk["goal_title"]
		}
		assert.Equal(t, "Ship the beta", titles["linked"], path)
		assert.Nil(t, titles["loose"], "no goal, no goal_title: %s", path)
	}
}
