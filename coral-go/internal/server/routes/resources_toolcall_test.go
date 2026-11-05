package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/proctree"
	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/store"
)

// #13718: a claim an agent makes by hand belongs to the tool call it is made in: when the call ends the slot goes back, with no release command. The Operator's own claim has no call and keeps its lease.
func TestAnAgentsHandClaimEndsWithItsToolCallAndTheOperatorsDoesNot(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	hook := resources.NewHook(g.mgr, resources.HookOptions{})
	h := &ResourcesHandler{M: g.mgr, Board: g.bs, Hook: hook, ToolCall: func(sid string) string { return "call-" + sid }}
	r := chi.NewRouter()
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Put("/api/resources/{name}", h.Define)
	r.Get("/api/resources/{name}", h.Get)
	g.r = r
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 2})

	claim := func(withSession bool) int {
		var buf bytes.Buffer
		require.NoError(t, json.NewEncoder(&buf).Encode(map[string]any{"subscriber_id": "Dev A"}))
		req := httptest.NewRequest("POST", "/api/resources/mac-heavy/claim", &buf)
		req.Header.Set("Content-Type", "application/json")
		req = withActor(req, Actor{Kind: ActorToken, Name: "Dev A", Session: "claude-sid-a"})
		if withSession {
			req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-sid-a"}))
		}
		rec := httptest.NewRecorder()
		g.r.ServeHTTP(rec, req)
		return rec.Code
	}
	holders := func() int {
		_, st := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
		return len(st["holders"].([]any))
	}
	assert.Equal(t, http.StatusOK, claim(true))
	assert.Equal(t, 1, holders())
	hook.After("sid-a", "call-sid-a") // the Bash call that made the claim ended
	assert.Equal(t, 0, holders(), "the slot went back with no release")

	assert.Equal(t, http.StatusOK, claim(false)) // no verified session: nothing to bind it to
	hook.After("sid-a", "call-sid-a")
	hook.TurnEnded("sid-a")
	assert.Equal(t, 1, holders(), "a claim with no tool call keeps its lease")
}

// #13718: a claim made by a job in the background names the shell that ran it: its slot outlives the tool call while the work that call started under that shell runs.
func TestAClaimNamesItsShellSoABackgroundJobKeepsTheSlotAfterItsCall(t *testing.T) {
	g := newResRig(t)
	g.subscribe("alpha", "Dev A", "Developer", false)
	var mu sync.Mutex
	procs := []proctree.Proc{{PID: 999, PPID: 1, Command: "claude"}, {PID: 4321, PPID: 999, Command: "sh -c claim; go test"}, {PID: 4322, PPID: 4321, Command: "coral-board resource claim"}}
	hook := resources.NewHook(g.mgr, resources.HookOptions{Procs: func() ([]proctree.Proc, bool) {
		mu.Lock()
		defer mu.Unlock()
		return append([]proctree.Proc(nil), procs...), true
	}})
	h := &ResourcesHandler{M: g.mgr, Board: g.bs, Hook: hook, ToolCall: func(string) string { return "call-1" }, AgentPID: func(string) int { return 999 }}
	r := chi.NewRouter()
	r.Post("/api/resources/{name}/claim", h.Claim)
	r.Put("/api/resources/{name}", h.Define)
	r.Get("/api/resources/{name}", h.Get)
	g.r = r
	g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
	claim := func(parent int) {
		var buf bytes.Buffer
		require.NoError(t, json.NewEncoder(&buf).Encode(map[string]any{"subscriber_id": "Dev A", "parent_pid": parent}))
		req := httptest.NewRequest("POST", "/api/resources/mac-heavy/claim", &buf)
		req.Header.Set("Content-Type", "application/json")
		req = withActor(req, Actor{Kind: ActorToken, Name: "Dev A", Session: "claude-sid-a"})
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-sid-a"}))
		rec := httptest.NewRecorder()
		g.r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
	}
	holders := func() int {
		_, st := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
		return len(st["holders"].([]any))
	}
	claim(4321)
	mu.Lock()
	procs = []proctree.Proc{{PID: 999, PPID: 1, Command: "claude"}, {PID: 4321, PPID: 999, Command: "sh -c claim; go test"}, {PID: 4400, PPID: 4321, Command: "go test ./..."}} // the claim returned, the work started
	mu.Unlock()
	hook.After("sid-a", "call-1") // the call returned at once, the job runs on
	hook.Sweep()
	assert.Equal(t, 1, holders(), "the work the call started runs: the slot stays")
	mu.Lock()
	procs = []proctree.Proc{{PID: 999, PPID: 1, Command: "claude"}}
	mu.Unlock()
	hook.Sweep()
	assert.Equal(t, 0, holders(), "the job ended: the slot went back")
}

// #13718: a parent that is the agent itself (a shell that ran a simple command directly), or a pid that is not below the agent, says nothing about the job: the claim follows its call alone.
func TestAClaimWhoseParentIsNotBelowTheAgentFollowsItsCallAlone(t *testing.T) {
	for _, parent := range []int{999, 888} { // the agent itself; somebody else's process
		g := newResRig(t)
		g.subscribe("alpha", "Dev A", "Developer", false)
		procs := []proctree.Proc{{PID: 999, PPID: 1, Command: "claude"}, {PID: 888, PPID: 1, Command: "daemon"}, {PID: 5000, PPID: 888, Command: "busy"}}
		hook := resources.NewHook(g.mgr, resources.HookOptions{Procs: func() ([]proctree.Proc, bool) { return procs, true }})
		h := &ResourcesHandler{M: g.mgr, Board: g.bs, Hook: hook, ToolCall: func(string) string { return "call-1" }, AgentPID: func(string) int { return 999 }}
		r := chi.NewRouter()
		r.Post("/api/resources/{name}/claim", h.Claim)
		r.Put("/api/resources/{name}", h.Define)
		r.Get("/api/resources/{name}", h.Get)
		g.r = r
		g.do("operator", "PUT", "/api/resources/mac-heavy", map[string]any{"slots": 1})
		var buf bytes.Buffer
		require.NoError(t, json.NewEncoder(&buf).Encode(map[string]any{"subscriber_id": "Dev A", "parent_pid": parent}))
		req := httptest.NewRequest("POST", "/api/resources/mac-heavy/claim", &buf)
		req.Header.Set("Content-Type", "application/json")
		req = withActor(req, Actor{Kind: ActorToken, Name: "Dev A", Session: "claude-sid-a"})
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: "sid-a", SessionName: "claude-sid-a"}))
		rec := httptest.NewRecorder()
		g.r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code)
		hook.After("sid-a", "call-1")
		_, st := g.do("operator", "GET", "/api/resources/mac-heavy", nil)
		assert.Len(t, st["holders"].([]any), 0, "parent %d is not below the agent: the claim ended with its call", parent)
	}
}

// #13718: the call a hand claim is tied to is the one the PreToolUse post recorded, for a command that matches no resource too.
func TestTheCurrentToolCallIsTheOneThePreToolUsePostRecorded(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-13718-a000-0000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Agent A", WorkingDir: "/w"}))
	tok := agentToken(t, h, sid, "claude-"+sid)
	body, _ := json.Marshal(map[string]any{"session_id": sid, "tool_use_id": "toolu_9", "tool_name": "Bash", "tool_input": map[string]any{"command": "echo hi"}})
	req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/x/pending-tool", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(store.SessionTokenHeader, tok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, "toolu_9", h.CurrentToolCall(sid))
	assert.Equal(t, "", h.CurrentToolCall("someone-else"))
}
