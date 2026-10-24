package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #7271 (goals steering, backend): PATCH .../goals/{id} takes an optional answer when a blocked goal goes back to active. One write keeps the answer with the goal and posts ONE board message from the person
// naming the driver, the question the goal waited on and the answer; closing a goal posts one board line with the state, the reason and the open-task count.
func steeringRig(t *testing.T) (call func(method, path string, body any) (int, map[string]any), h *BoardHandler, gid int64) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	registerTaskPlanner(t, h, "team", "Orchestrator")
	_, err := h.bs.Subscribe(ctx, "team", "Lead", "Developer", "s-lead", nil, "")
	require.NoError(t, err)
	call = goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "Ship it", "driver": "Lead", "subscriber_id": "Orchestrator"})
	gid = int64(g["id"].(float64))
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "blocked", "blocked_on": "the operator", "decision": "Ship Friday?", "recommendation": "yes", "if_silent": "ship Monday", "subscriber_id": "Orchestrator"})
	require.Equal(t, 200, code, "%v", out)
	return call, h, gid
}

func messagesOf(t *testing.T, h *BoardHandler) []board.Message {
	t.Helper()
	msgs, err := h.bs.ListMessages(context.Background(), "team", 100, 0, 0)
	require.NoError(t, err)
	return msgs
}

func TestAnsweringABlockedGoalStoresTheAnswerAndPostsOneMessage(t *testing.T) {
	call, h, gid := steeringRig(t)
	before := len(messagesOf(t, h))
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "active", "answer": "Yes, ship Friday\x1b[31m", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "active", out["state"])
	assert.Equal(t, "Yes, ship Friday", out["answer"], "cleaned like a reason: the escape sequence is gone")
	assert.NotContains(t, out, "decision", "the question leaves the goal with the block")

	msgs := messagesOf(t, h)
	require.Len(t, msgs, before+1, "one board message for the write")
	m := msgs[len(msgs)-1]
	assert.Equal(t, "Operator", m.SubscriberID, "from the person who answered")
	assert.Contains(t, m.Content, "@Lead", "naming the driver")
	assert.Contains(t, m.Content, "Ship Friday?", "the question the goal waited on")
	assert.Contains(t, m.Content, "Yes, ship Friday", "and the answer")
	assert.Contains(t, m.Content, "Ship it", "and the goal")

	// The same answer again is not a second message: the goal is no longer blocked.
	code, out = call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "active", "answer": "again", "subscriber_id": "Operator"})
	assert.Equal(t, 400, code, "%v", out)
	assert.Equal(t, "goal_answer_not_applicable", out["code"])
	assert.Len(t, messagesOf(t, h), before+1)
}

func TestAnswerRefusalsStoreAndPostNothing(t *testing.T) {
	call, h, gid := steeringRig(t)
	before := len(messagesOf(t, h))
	for name, body := range map[string]map[string]any{
		"an answer with no state change":    {"answer": "yes"},
		"an answer moving to proposed":      {"state": "proposed", "answer": "yes"},
		"an answer staying blocked":         {"state": "blocked", "blocked_on": "x", "answer": "yes"},
		"an answer over 300 characters":     {"state": "active", "answer": strings.Repeat("a", 301)},
		"an empty answer with a state move": {"state": "active", "answer": "  "},
	} {
		body["subscriber_id"] = "Operator"
		code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), body)
		assert.Equal(t, 400, code, "%s: %v", name, out)
	}
	g, err := h.bs.GetGoal(context.Background(), "team", gid)
	require.NoError(t, err)
	assert.Equal(t, "blocked", g.State, "still blocked: nothing was written")
	assert.Empty(t, g.Answer)
	assert.Len(t, messagesOf(t, h), before, "and nothing was posted")

	// An unblock with no answer posts nothing either.
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "active", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	assert.Len(t, messagesOf(t, h), before)
}

func TestAnAnswerOnAGoalWithNoDriverNamesWhatItWaitedOn(t *testing.T) {
	server, h := setupBoardTestServer(t)
	registerTaskPlanner(t, h, "team", "Orchestrator")
	call := goalCall(t, server.URL)
	_, g := call("POST", "/api/board/team/goals", map[string]any{"title": "No driver", "subscriber_id": "Orchestrator"})
	gid := int64(g["id"].(float64))
	code, out := call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "blocked", "blocked_on": "Orchestrator", "subscriber_id": "Orchestrator"})
	require.Equal(t, 200, code, "%v", out)
	before := len(messagesOf(t, h))
	code, out = call("PATCH", "/api/board/team/goals/"+itoa(gid), map[string]any{"state": "active", "answer": "go", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	msgs := messagesOf(t, h)
	require.Len(t, msgs, before+1)
	assert.Contains(t, msgs[len(msgs)-1].Content, "@Orchestrator", "blocked_on is mentioned when there is no driver")
}

func TestClosingAGoalPostsOneBoardLine(t *testing.T) {
	call, h, gid := steeringRig(t)
	_, err := h.bs.CreateTaskWithOpts(context.Background(), "team", "open task", "", "medium", "Orchestrator", &board.CreateTaskOpts{GoalID: &gid})
	require.NoError(t, err)
	before := len(messagesOf(t, h))
	code, out := call("POST", "/api/board/team/goals/"+itoa(gid)+"/close", map[string]any{"reason": "shipped Friday", "state": "done", "subscriber_id": "Operator"})
	require.Equal(t, 200, code, "%v", out)
	msgs := messagesOf(t, h)
	require.Len(t, msgs, before+1, "one line")
	m := msgs[len(msgs)-1]
	assert.Equal(t, "Operator", m.SubscriberID)
	assert.Contains(t, m.Content, "Ship it")
	assert.Contains(t, m.Content, "done", "the state")
	assert.Contains(t, m.Content, "shipped Friday", "the reason")
	assert.Contains(t, m.Content, "1 open task", "and how many tasks were still open")

	// Closing it again is refused and posts nothing.
	code, _ = call("POST", "/api/board/team/goals/"+itoa(gid)+"/close", map[string]any{"reason": "again", "subscriber_id": "Operator"})
	assert.Equal(t, 409, code)
	assert.Len(t, messagesOf(t, h), before+1)
}

// Through Coral Hub the answer's message is the Operator's, made by the Hub user and marked as a Hub-operator post, as a chat post is; the goal write is the same one write.
func TestAnAnswerThroughCoralHubIsPostedAsTheOperatorWithTheHubUser(t *testing.T) {
	bs, err := boardtest.Open(t.TempDir() + "/board.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "team", "Lead", "Developer", "s-lead", nil, "mentions")
	require.NoError(t, err)
	g, err := bs.CreateGoal(ctx, "team", board.GoalInput{Title: "Ship it", Driver: "Lead", CreatedBy: "Operator"})
	require.NoError(t, err)
	blocked, on, q := "blocked", "the operator", "Ship Friday?"
	_, err = bs.UpdateGoal(ctx, "team", g.ID, board.GoalUpdate{State: &blocked, BlockedOn: &on, Decision: &q})
	require.NoError(t, err)
	r := chi.NewRouter()
	r.Use(TunnelIdentityGuard(bs, func(*http.Request) bool { return true }))
	r.Patch("/api/board/{project}/goals/{goalID}", h.UpdateGoal)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	const alice = "hub-user-1111aaaa"
	body, _ := json.Marshal(map[string]any{"state": "active", "answer": "Yes", "subscriber_id": "Operator"})
	req, err := http.NewRequest("PATCH", srv.URL+"/api/board/team/goals/"+itoa(g.ID), bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	req.Header.Set(tunnel.HubUserHeader, alice)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	msgs, err := bs.ListMessages(ctx, "team", 10, 0, 0)
	require.NoError(t, err)
	var posted []board.Message
	for _, m := range msgs {
		if strings.Contains(m.Content, "Answer: Yes") {
			posted = append(posted, m)
		}
	}
	require.Len(t, posted, 1, "one message")
	assert.Equal(t, "Operator", posted[0].SubscriberID)
	require.NotNil(t, posted[0].Origin)
	assert.Equal(t, board.OriginHubOperator, *posted[0].Origin)
	assert.True(t, strings.HasPrefix(posted[0].Content, HubOperatorPrefix(alice)), "the Hub user is named as for a chat post: %q", posted[0].Content)
	assert.Contains(t, posted[0].Content, "@Lead")
}
