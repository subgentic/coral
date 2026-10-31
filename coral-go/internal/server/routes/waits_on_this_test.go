package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// The server says what waits on an Inbox item (#11455): a live row's in-progress tasks and what waits on them on every board, a "for review" artifact row's task and the goal it would close. The browser asks nothing.
func TestLiveRowsSayWhatWaitsOnTheirAgentOnEveryBoard(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	const sessA, sessB = "aaaaaaaa-0000-4000-8000-000000011455", "bbbbbbbb-0000-4000-8000-000000011455"
	subscribeSession(t, h, "team", "Worker A", sessA)
	subscribeSession(t, h, "team", "Worker B", sessB) // nothing in progress
	mine, err := h.bs.CreateTaskWithOpts(ctx, "team", "Build the beta", "", "high", "Orchestrator", nil, "Worker A")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Worker A", mine.ID)
	require.NoError(t, err)
	_, err = h.bs.CreateTaskWithOpts(ctx, "other-team", "Ship it from the other board", "", "critical", "Orchestrator", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: mine.ID, BoardID: "team"}}})
	require.NoError(t, err)

	sh := &SessionsHandler{bs: h.bs}
	rows := []map[string]any{
		{"session_id": sessA, "agent_type": "claude", "board_project": "team"},
		{"session_id": sessB, "agent_type": "claude", "board_project": "team"},
		{"session_id": "sid-none", "agent_type": "claude"},                                       // on no board
		{"session_id": sessA, "agent_type": "claude", "board_project": "team", "server": "box2"}, // a remote server's row
	}
	sh.addWaitsOnThis(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), rows)
	got, ok := rows[0]["waits_on_this"].(*board.WaitsOnThis)
	require.True(t, ok, "%v", rows[0])
	assert.Equal(t, board.WaitsOnThis{Count: 2, TopTitle: "Ship it from the other board", Priority: "critical"}, *got, "its own task and the one on the other board")
	assert.NotContains(t, rows[1], "waits_on_this", "nothing in progress: no field")
	assert.NotContains(t, rows[2], "waits_on_this")
	assert.NotContains(t, rows[3], "waits_on_this", "a remote server's row is not asked: its boards are not here")
	(&SessionsHandler{}).addWaitsOnThis(httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil), rows) // no board store: nothing breaks
}

// The field names task titles of every board: the Operator's alone, never an agent's, not even on its own row or a board mate's.
func TestWaitsOnThisIsNeverGivenToAnAgentToken(t *testing.T) {
	rows := rosterRows()
	for _, r := range rows {
		r["waits_on_this"] = &board.WaitsOnThis{Count: 3, TopTitle: "TITLE-" + r["name"].(string), Priority: "high"}
	}
	got := scopeRowsForAgent(rows, "sid-me")
	for i, r := range got {
		v, present := r["waits_on_this"]
		assert.True(t, !present || v == nil, "row %d: no waits_on_this for an agent: %v", i, r)
	}
	assert.NotNil(t, rows[0]["waits_on_this"], "the Operator's list is not changed in place")
}

func TestForReviewRowsSayWhatWaitsOnTheirTaskAndTheGoalItCloses(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	g, err := h.bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship the beta", Outcome: "o", DoneWhen: "d", CreatedBy: "Operator"})
	require.NoError(t, err)
	up, err := h.bs.CreateTaskWithOpts(ctx, "team", "Review me", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &g.ID})
	require.NoError(t, err)
	_, err = h.bs.CreateTaskWithOpts(ctx, "other-team", "Waits on the review", "", "high", "Orchestrator", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: up.ID, BoardID: "team"}}})
	require.NoError(t, err)

	rows := []teamArtifact{
		{TaskID: up.ID, Tags: []string{"for review"}, BoardID: "team"},
		{TaskID: up.ID, Tags: []string{"internal"}, BoardID: "team"}, // not for review: nobody asks
		{TaskID: up.ID, Tags: []string{"for review"}},                // a list of one team: its project
		{TaskID: 0, Tags: []string{"for review"}, BoardID: "team"},   // no task
	}
	h.addWaitsOnThis(httptest.NewRequest(http.MethodGet, "/api/team-artifacts", nil), "team", rows)
	require.NotNil(t, rows[0].WaitsOnThis)
	assert.Equal(t, board.WaitsOnThis{Count: 1, TopTitle: "Waits on the review", ClosesGoal: "Ship the beta", Priority: "high"}, *rows[0].WaitsOnThis)
	assert.Nil(t, rows[1].WaitsOnThis, "only a row tagged for review")
	require.NotNil(t, rows[2].WaitsOnThis, "a row with no board of its own takes the list's")
	assert.Nil(t, rows[3].WaitsOnThis, "a row with no task")
	(&BoardHandler{}).addWaitsOnThis(httptest.NewRequest(http.MethodGet, "/api/team-artifacts", nil), "team", rows) // no board store: nothing breaks
}

func TestWaitsOnMemoKeepsTheAnswerForTheSameSessionsBriefly(t *testing.T) {
	var m waitsOnMemo
	a := []board.WaitOwner{{Key: "a"}, {Key: "b"}}
	_, ok := m.get(a)
	assert.False(t, ok, "nothing kept yet")
	m.set(a, map[string]board.WaitsOnThis{"a": {Count: 1}})
	got, ok := m.get([]board.WaitOwner{{Key: "b"}, {Key: "a"}})
	assert.True(t, ok, "the same sessions in any order")
	assert.Equal(t, 1, got["a"].Count)
	_, ok = m.get([]board.WaitOwner{{Key: "a"}, {Key: "c"}})
	assert.False(t, ok, "other sessions are read again")
}

// Through Coral Hub only the authentic owner gets the field: a viewer or grantee, a forged stamp, or an owner of a machine with no enrolled label gets none, on the live rows and on the review rows alike (Security, #11455).
func TestWaitsOnThisThroughTheHubIsTheAuthenticOwnersAlone(t *testing.T) {
	_, h := setupBoardTestServer(t)
	ctx := context.Background()
	const sess = "aaaaaaaa-0000-4000-8000-000000011456"
	subscribeSession(t, h, "team", "Worker A", sess)
	mine, err := h.bs.CreateTaskWithOpts(ctx, "team", "Build", "", "high", "Orchestrator", nil, "Worker A")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, "team", "Worker A", mine.ID)
	require.NoError(t, err)
	_, err = h.bs.CreateTaskWithOpts(ctx, "other-team", "Waits", "", "critical", "Orchestrator", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: mine.ID, BoardID: "team"}}})
	require.NoError(t, err)
	withLabel(t, ownerLabel, nil)
	sh := &SessionsHandler{bs: h.bs}
	for _, c := range []struct {
		name   string
		header map[string]string
		want   bool
	}{
		{"this computer's dashboard", nil, true},
		{"the owner through the hub", ownerHeaders(ownerLabel), true},
		{"a viewer or grantee", granteeHeaders(), false},
		{"a forged stamp", map[string]string{tunnel.ViaHeader: "x", tunnel.HubRoleHeader: "owner", tunnel.HubUserHeader: ownerLabel}, false},
		{"another hub user's owner marker", ownerHeaders("hub-user-9999ffff"), false},
	} {
		live := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
		review := httptest.NewRequest(http.MethodGet, "/api/team-artifacts", nil)
		for k, v := range c.header {
			live.Header.Set(k, v)
			review.Header.Set(k, v)
		}
		rows := []map[string]any{{"session_id": sess, "agent_type": "claude", "board_project": "team"}}
		sh.addWaitsOnThis(live, rows)
		items := []teamArtifact{{TaskID: mine.ID, Tags: []string{"for review"}, BoardID: "team"}}
		h.addWaitsOnThis(review, "team", items)
		if c.want {
			assert.Contains(t, rows[0], "waits_on_this", c.name)
			assert.NotNil(t, items[0].WaitsOnThis, c.name)
		} else {
			assert.NotContains(t, rows[0], "waits_on_this", c.name)
			assert.Nil(t, items[0].WaitsOnThis, c.name)
		}
	}
}

// The review rows of the team list: the Operator's request gets what waits on a "for review" row's task, a verified agent session gets none, on the real handler (QA Engineer's MUST, #11455).
func TestTeamArtifactListGivesWaitsOnThisToThePersonAndNeverToAnAgent(t *testing.T) {
	e := newReviewEnv(t, true)
	ctx := context.Background()
	e.tag(t, `["for review"]`)
	tasks, err := e.h.bs.ListTasks(ctx, "alpha")
	require.NoError(t, err)
	var work int64
	for _, tk := range tasks {
		if tk.Title == "A work" {
			work = tk.ID
		}
	}
	require.NotZero(t, work)
	_, err = e.h.bs.CreateTaskWithOpts(ctx, "beta", "Waits on the work, on another board", "", "critical", "Orchestrator", &board.CreateTaskOpts{BlockedBy: []board.TaskDep{{TaskID: work, BoardID: "alpha"}}})
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Get("/person/api/board/{project}/artifacts", e.h.ListTeamArtifacts)
	r.Get("/agent/api/board/{project}/artifacts", func(w http.ResponseWriter, req *http.Request) {
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: sessAlice}))
		e.h.ListTeamArtifacts(w, req)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	rowsOf := func(prefix string) []map[string]any {
		resp, err := http.Get(srv.URL + prefix + "/api/board/alpha/artifacts")
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, 200, resp.StatusCode)
		var out struct {
			Artifacts []map[string]any `json:"artifacts"`
		}
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out.Artifacts
	}
	person := rowsOf("/person")
	require.NotEmpty(t, person)
	w, ok := person[0]["waits_on_this"].(map[string]any)
	require.True(t, ok, "the person's list: %v", person[0])
	assert.EqualValues(t, 1, w["count"])
	assert.Equal(t, "Waits on the work, on another board", w["top_title"])
	agent := rowsOf("/agent")
	require.NotEmpty(t, agent)
	for _, row := range agent {
		assert.NotContains(t, row, "waits_on_this", "an agent's token gets no other board's task titles: %v", row)
	}
}
