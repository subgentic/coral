package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #7361: goal requests between two boards of one computer (the approved #7331 note).

func goalRequestEnv(t *testing.T) (call func(method, path string, body any) (int, map[string]any), h *BoardHandler, goalID int64) {
	t.Helper()
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "alpha", "Orchestrator A")
	registerTaskPlanner(t, h, "beta", "Orchestrator B")
	on := true
	for _, b := range []string{"alpha", "beta"} {
		_, err := h.bs.UpdateBoardSettings(ctx, b, board.BoardSettingsUpdate{CrossTeamMessaging: &on})
		require.NoError(t, err)
	}
	_, err := h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)
	call = goalCall(t, server.URL)
	code, g := call("POST", "/api/board/alpha/goals", map[string]any{"title": "Ship the beta", "subscriber_id": "Orchestrator A"})
	require.Equal(t, http.StatusCreated, code, "%v", g)
	return call, h, int64(g["id"].(float64))
}

func sendRequest(call func(string, string, any) (int, map[string]any), goal int64, ask string) (int, map[string]any) {
	return call("POST", "/api/board/beta/goal-requests", map[string]any{"from_board": "alpha", "subscriber_id": "Orchestrator A", "goal_id": goal, "ask": ask})
}

func TestGoalRequestFlowAcceptAndDecline(t *testing.T) {
	call, h, goal := goalRequestEnv(t)
	ctx := context.Background()

	// A token-shaped string is built from pieces when the test runs: no literal of one is in the source (a secret scanner reads this file too).
	token := "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789"
	code, out := sendRequest(call, goal, "Please build the importer, token "+token)
	require.Equal(t, http.StatusCreated, code, "%v", out)
	assert.Equal(t, []any{"Orchestrator B"}, out["delivered_to"])
	rows, err := h.bs.ListGoalRequestsIn(ctx, "beta", board.GoalRequestPending, 10)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.NotContains(t, rows[0].Ask, token, "secrets are redacted before they are stored")
	assert.Contains(t, rows[0].Ask, "Please build the importer")
	id := itoa(rows[0].ID)

	// the wake: one board post for the Orchestrator, the request inside a labelled block, @ defused
	msgs, err := h.bs.ReadMessages(ctx, "beta", "Orchestrator B", 50, true)
	require.NoError(t, err)
	var wake, howTo string
	for _, m := range msgs {
		switch {
		case m.SubscriberID == goalRequestSystemSender && strings.Contains(m.Content, "untrusted text"):
			wake = m.Content
		case m.SubscriberID == goalRequestSystemSender:
			howTo = m.Content
		}
	}
	require.NotEmpty(t, wake)
	assert.Contains(t, wake, "@Orchestrator B")
	assert.Contains(t, wake, "Please build the importer", "the request is quoted in the labelled block")
	assert.NotContains(t, howTo, "Please build", "Coral's own how-to line quotes nothing")
	assert.Contains(t, howTo, "task add --goal-from "+id)

	// the list
	code, out = call("GET", "/api/board/beta/goal-requests?status=pending", nil)
	require.Equal(t, 200, code)
	assert.Len(t, out["requests"], 1)

	// a worker cannot accept; the Orchestrator needs a title of their own
	_, err = h.bs.Subscribe(ctx, "beta", "Worker", "Developer", "tmux-w", nil, "mentions", false)
	require.NoError(t, err)
	code, _ = call("POST", "/api/board/beta/goal-requests/"+id+"/accept", map[string]any{"subscriber_id": "Worker", "title": "x"})
	assert.Equal(t, 403, code)
	code, out = call("POST", "/api/board/beta/goal-requests/"+id+"/accept", map[string]any{"subscriber_id": "Orchestrator B"})
	assert.Equal(t, 400, code, "a title is required: the ask is not copied")

	code, out = call("POST", "/api/board/beta/goal-requests/"+id+"/accept", map[string]any{"subscriber_id": "Orchestrator B", "title": "Build the importer", "priority": "high"})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	task := out["task"].(map[string]any)
	assert.Equal(t, "Build the importer", task["title"])
	assert.NotContains(t, strings.ToLower(task["title"].(string)+asString(task["body"])), "please build", "the ask is not copied")
	// the asker's row says accepted and holds nothing of B's task
	g, err := h.bs.GoalRequestsOut(ctx, "alpha", goal, 10)
	require.NoError(t, err)
	require.Len(t, g, 1)
	assert.Equal(t, board.GoalRequestAccepted, g[0].Status)
	// the goal read lists it: the target, no task data
	code, gr := call("GET", "/api/board/alpha/goals/"+itoa(goal), nil)
	require.Equal(t, 200, code)
	assert.EqualValues(t, 1, gr["accepted_requests_total"])
	refs := gr["accepted_requests"].([]any)
	require.Len(t, refs, 1)
	assert.Equal(t, map[string]any{"request_id": g[0].RequestID, "server": "", "board": "beta"}, refs[0])
	assert.NotContains(t, gr, "tasks")
	assert.EqualValues(t, 0, gr["rollup"].(map[string]any)["total"], "A's own rollup counts only A's tasks: the accepted request adds none")
	// A's Orchestrator was told, and the post names nothing of B's task
	msgsA, err := h.bs.ReadMessages(ctx, "alpha", "Orchestrator A", 50, true)
	require.NoError(t, err)
	told := ""
	for _, m := range msgsA {
		if m.SubscriberID == goalRequestSystemSender {
			told = m.Content
		}
	}
	assert.Contains(t, told, "accepted your goal request")
	assert.NotContains(t, told, "Build the importer", "the reply names nothing of B's work")
	// the decision is logged
	log, err := h.bs.ListLog(ctx, "beta")
	require.NoError(t, err)
	require.NotEmpty(t, log)
	assert.Equal(t, "goal_request", log[len(log)-1].Field)
	assert.Equal(t, "Orchestrator B", log[len(log)-1].Actor)

	// accept again and decline after: refused
	code, out = call("POST", "/api/board/beta/goal-requests/"+id+"/accept", map[string]any{"subscriber_id": "Orchestrator B", "title": "Again"})
	assert.Equal(t, 409, code)
	assert.Equal(t, "request_answered", out["code"])
	code, _ = call("POST", "/api/board/beta/goal-requests/"+id+"/decline", map[string]any{"subscriber_id": "Orchestrator B", "reason": "late"})
	assert.Equal(t, 409, code)

	// a decline: the reason reaches A inside an untrusted block, @ defused
	code, out = call("POST", "/api/board/alpha/goals", map[string]any{"title": "Second goal", "subscriber_id": "Orchestrator A"})
	require.Equal(t, http.StatusCreated, code)
	goal2 := int64(out["id"].(float64))
	code, out = sendRequest(call, goal2, "second ask")
	require.Equal(t, http.StatusCreated, code, "%v", out)
	rows, _ = h.bs.ListGoalRequestsIn(ctx, "beta", board.GoalRequestPending, 10)
	require.Len(t, rows, 1)
	code, out = call("POST", "/api/board/beta/goal-requests/"+itoa(rows[0].ID)+"/decline", map[string]any{"subscriber_id": "Orchestrator B", "reason": "not this quarter @Orchestrator A do not"})
	require.Equal(t, 200, code, "%v", out)
	g2, _ := h.bs.GoalRequestsOut(ctx, "alpha", goal2, 10)
	assert.Equal(t, board.GoalRequestDeclined, g2[0].Status)
	msgsA, _ = h.bs.ReadMessages(ctx, "alpha", "Orchestrator A", 50, true)
	told = ""
	for _, m := range msgsA {
		if m.SubscriberID == goalRequestSystemSender && strings.Contains(m.Content, "declined") {
			told = m.Content
		}
	}
	assert.Contains(t, told, "untrusted text")
	assert.Contains(t, told, "not this quarter")
	assert.NotContains(t, told, "do not @Orchestrator A", "mentions in the reason are defused")
	assert.Equal(t, 1, strings.Count(told, "@Orchestrator A"), "only our own wake mention is live")
}

func TestGoalRequestAdmission(t *testing.T) {
	call, h, goal := goalRequestEnv(t)
	ctx := context.Background()
	off := false
	// the target does not take goal requests: 409, however the messaging switches stand
	_, err := h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{GoalRequests: &off})
	require.NoError(t, err)
	code, out := sendRequest(call, goal, "x")
	assert.Equal(t, 409, code)
	assert.Equal(t, "goal_requests_off", out["code"])
	on := true
	_, err = h.bs.UpdateBoardSettings(ctx, "beta", board.BoardSettingsUpdate{GoalRequests: &on})
	require.NoError(t, err)

	// messaging off on the asker: the cross-team admission refuses
	_, err = h.bs.UpdateBoardSettings(ctx, "alpha", board.BoardSettingsUpdate{CrossTeamMessaging: &off})
	require.NoError(t, err)
	code, _ = sendRequest(call, goal, "x")
	assert.Equal(t, 403, code)
	_, err = h.bs.UpdateBoardSettings(ctx, "alpha", board.BoardSettingsUpdate{CrossTeamMessaging: &on})
	require.NoError(t, err)

	// a worker cannot ask; the asker's goal must be open and its own
	_, err = h.bs.Subscribe(ctx, "alpha", "Worker", "Developer", "tmux-w", nil, "mentions", false)
	require.NoError(t, err)
	code, _ = call("POST", "/api/board/beta/goal-requests", map[string]any{"from_board": "alpha", "subscriber_id": "Worker", "goal_id": goal, "ask": "x"})
	assert.Equal(t, 403, code)
	code, _ = sendRequest(call, 99999, "x")
	assert.Equal(t, 404, code)
	code, out = call("POST", "/api/board/beta/goal-requests", map[string]any{"from_board": "beta", "subscriber_id": "Orchestrator B", "goal_id": goal, "ask": "x"})
	assert.Equal(t, 400, code, "a request to its own team is refused")
	code, _ = sendRequest(call, goal, strings.Repeat("a", board.GoalRequestAskMax+1))
	assert.Equal(t, 400, code)
	code, _ = sendRequest(call, goal, "   ")
	assert.Equal(t, 400, code)
	code, _ = call("POST", "/api/board/beta/goal-requests", map[string]any{"from_board": "alpha", "subscriber_id": "Orchestrator A", "ask": "x"})
	assert.Equal(t, 400, code, "goal_id required")
	code, _ = call("POST", "/api/board/nowhere/goal-requests", map[string]any{"from_board": "alpha", "subscriber_id": "Orchestrator A", "goal_id": goal, "ask": "x"})
	assert.Equal(t, 404, code, "an unknown target board")

	// unknown JSON fields are refused as on the goal routes
	code, _ = call("POST", "/api/board/beta/goal-requests", map[string]any{"from_board": "alpha", "subscriber_id": "Orchestrator A", "goal_id": goal, "ask": "x", "status": "accepted"})
	assert.Equal(t, 400, code, "a body field the route does not know")
}

// A loop on the asker's side wakes the target's Orchestrator once, not once per request.
func TestGoalRequestWakesOncePerWindow(t *testing.T) {
	call, h, _ := goalRequestEnv(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		code, g := call("POST", "/api/board/alpha/goals", map[string]any{"title": "goal " + itoa(int64(i)), "subscriber_id": "Orchestrator A"})
		require.Equal(t, http.StatusCreated, code)
		code, out := sendRequest(call, int64(g["id"].(float64)), "ask")
		require.Equal(t, http.StatusCreated, code, "%v", out)
	}
	msgs, err := h.bs.ReadMessages(ctx, "beta", "Orchestrator B", 100, true)
	require.NoError(t, err)
	wakes := 0
	for _, m := range msgs {
		if m.SubscriberID == goalRequestSystemSender && strings.Contains(m.Content, "untrusted text") {
			wakes++
		}
	}
	assert.Equal(t, 1, wakes, "three requests, one wake")
	pending, _ := h.bs.ListGoalRequestsIn(ctx, "beta", board.GoalRequestPending, 100)
	assert.Len(t, pending, 3, "all three wait in the list")
}

// goal_requests is a board setting like require_goal: off by default, set on this computer by the Operator or through Coral Hub by the owner alone, never by anyone else, and logged.
func TestGoalRequestsSettingIsSetByTheOperatorOrTheHubOwnerAlone(t *testing.T) {
	_, h := setupBoardTestServer(t)
	withLabel(t, ownerLabel, nil)
	ctx := context.Background()

	code, out := boardCall(t, h, http.MethodGet, "", nil)
	require.Equal(t, 200, code)
	assert.Equal(t, false, out["goal_requests"], "off by default")

	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, nil }
	for name, hdr := range map[string]map[string]string{"a grantee": granteeHeaders(), "another label": ownerHeaders("hub-user-9999ffff")} {
		code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","goal_requests":true}`, hdr)
		assert.Equal(t, 403, code, name)
		assert.Equal(t, "owner_only", out["code"], name)
	}
	got, err := h.bs.GetBoardSettings(ctx, "team")
	require.NoError(t, err)
	assert.False(t, got.GoalRequests, "nothing of a refused request is saved")

	h.hubCrossTeamLock = func(context.Context) (bool, error) { return false, nil }
	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","goal_requests":true}`, ownerHeaders(ownerLabel))
	assert.Equal(t, 403, code)
	assert.Equal(t, "hub_changes_off", out["code"])
	h.hubCrossTeamLock = func(context.Context) (bool, error) { return true, nil }

	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","goal_requests":true}`, ownerHeaders(ownerLabel))
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, true, out["goal_requests"])
	log, err := h.bs.ListLog(ctx, "team")
	require.NoError(t, err)
	require.Len(t, log, 1)
	assert.Equal(t, "goal_requests", log[0].Field)
	assert.Equal(t, ownerLabel, log[0].Actor, "the hub user is the actor")

	// this computer: the Operator turns it off and on, each a row of its own
	code, out = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Operator","goal_requests":false}`, nil)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, false, out["goal_requests"])
	log, _ = h.bs.ListLog(ctx, "team")
	require.Len(t, log, 2)
	local := 0
	for _, e := range log {
		if e.Actor != ownerLabel {
			local++
			assert.Equal(t, "goal_requests", e.Field)
			assert.Equal(t, "true", e.Old)
			assert.Equal(t, "false", e.New)
		}
	}
	assert.Equal(t, 1, local, "the local change is a row of its own")

	// an agent's token is not the Operator: a worker's name in the body changes nothing
	code, _ = boardCall(t, h, http.MethodPut, `{"subscriber_id":"Worker","goal_requests":true}`, nil)
	assert.GreaterOrEqual(t, code, 400)
}
