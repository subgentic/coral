package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #17587: at the PreToolUse post, a Claude agent whose pool slot is on another machine is answered with "run" (its own command, wrapped to run there), not a refusal; a Codex agent is told to run it itself.
func TestAClaudeCommandWhoseSlotIsRemoteIsAnsweredWithTheCommandToRunThere(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	mgr, err := resources.Open(resources.Options{AgeStep: -1})
	require.NoError(t, err)
	q := mgr.Queue()
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Machine: "Mac", Where: resourcequeue.WhereHere}))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "frontier", Slots: 1, Machine: "Frontier", Where: resourcequeue.WhereRemote}))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "heavy", Members: []string{"mac-heavy", "frontier"}, Match: []string{"go test ./..."}}))
	sids := map[string]string{"A": "eeeeeeee-17587-a000-0000-000000000001", "B": "eeeeeeee-17587-b000-0000-000000000002", "C": "eeeeeeee-17587-c000-0000-000000000003"}
	types := map[string]string{"A": "claude", "B": "claude", "C": "codex"}
	members := map[string]string{}
	toks := map[string]string{}
	for k, sid := range sids {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: types[k], AgentName: "Agent " + k, WorkingDir: "/w"}))
		members[types[k]+"-"+sid] = "Agent " + k
		toks[k] = agentToken(t, h, sid, types[k]+"-"+sid)
	}
	h.SetResourceHook(resources.NewHook(mgr, resources.HookOptions{Agent: func(_ context.Context, name string) (string, bool) { m, ok := members[name]; return m, ok }}))
	post := func(k, toolUseID, command string) map[string]any {
		body, _ := json.Marshal(map[string]any{"session_id": sids[k], "tool_use_id": toolUseID, "tool_name": "Bash", "tool_input": map[string]any{"command": command}})
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/x/pending-tool", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, toks[k])
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	const cmd = "cd coral-go && SECRET=hunter2 go test ./... | tail"

	out := post("A", "t1", cmd)
	assert.Nil(t, out["refuse"])
	assert.Nil(t, out["run"], "the Mac's own grant runs as typed")

	out = post("B", "t2", cmd) // the next slot of the pool is Frontier's
	assert.Nil(t, out["refuse"], "no refusal telling the agent to retype")
	assert.Equal(t, resources.RemoteCommand(cmd), out["run"])
	_, pending := h.pending.get(sids["B"], time.Now())
	assert.True(t, pending, "it is still a tool call: recorded as pending")
	st, _ := q.Status("frontier")
	require.Len(t, st.Holders, 1, "and holds Frontier's slot while it runs")

	h.notePendingToolEvent(sids["B"], "tool_use", "t2")
	st, _ = q.Status("frontier")
	assert.Empty(t, st.Holders, "the slot goes back when the call ends")

	post("B", "t3", cmd) // B holds Frontier again, so C (Codex) finds the pool full: held, not rewritten
	out = post("C", "t4", cmd)
	assert.NotNil(t, out["refuse"])
	assert.Nil(t, out["run"])
}
