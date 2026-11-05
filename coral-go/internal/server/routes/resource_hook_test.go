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

// #13645: the shell hook at the PreToolUse post and at the end of the call, against a real sessions handler.

func TestAHeavyBashCommandClaimsASlotAtTheHookPostAndGivesItBackWhenTheCallEnds(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	mgr, err := resources.Open(resources.Options{AgeStep: -1})
	require.NoError(t, err)
	require.NoError(t, mgr.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Match: []string{"go test ./..."}}))
	sidA, sidB := "eeeeeeee-13645-a000-0000-000000000001", "eeeeeeee-13645-b000-0000-000000000002"
	members := map[string]string{}
	for sid, who := range map[string]string{sidA: "Agent A", sidB: "Agent B"} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: who, WorkingDir: "/w"}))
		members["claude-"+sid] = who
	}
	h.SetResourceHook(resources.NewHook(mgr, resources.HookOptions{
		Agent: func(_ context.Context, name string) (string, bool) { m, ok := members[name]; return m, ok },
	}))
	tokA, tokB := agentToken(t, h, sidA, "claude-"+sidA), agentToken(t, h, sidB, "claude-"+sidB)

	post := func(tok, sid, tool, toolUseID, command string) map[string]any {
		body, _ := json.Marshal(map[string]any{"session_id": sid, "tool_use_id": toolUseID, "tool_name": tool, "tool_input": map[string]any{"command": command}})
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/x/pending-tool", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	holders := func() []string {
		st, _ := mgr.Queue().Status("mac-heavy")
		var out []string
		for _, e := range st.Holders {
			out = append(out, e.Agent)
		}
		return out
	}
	const heavy = "cd coral-go && SECRET=hunter2 go test ./... | tail"

	assert.Nil(t, post(tokA, sidA, "Bash", "t1", heavy)["refuse"], "a free machine: the command runs")
	assert.Equal(t, []string{"Agent A"}, holders(), "and A holds the slot meanwhile")

	out := post(tokB, sidB, "Bash", "t2", heavy)
	refuse, _ := out["refuse"].(string)
	assert.Contains(t, refuse, "number 1 in line")
	assert.Contains(t, refuse, "coral-board resource claim mac-heavy --wait")
	assert.NotContains(t, refuse, "hunter2", "the command is never repeated")
	_, pending := h.pending.get(sidB, time.Now())
	assert.False(t, pending, "a held command does not run: it is not a pending tool")
	st, _ := mgr.Queue().Status("mac-heavy")
	require.Len(t, st.Queue, 1)
	assert.Equal(t, "auto: go test ./...", st.Queue[0].Note)

	// A's call ends (PostToolUse): the slot goes to B, whose retry then runs
	h.notePendingToolEvent(sidA, "tool_use", "t1")
	assert.Equal(t, []string{"Agent B"}, holders())
	assert.Nil(t, post(tokB, sidB, "Bash", "t3", heavy)["refuse"])
	h.notePendingToolEvent(sidB, "tool_use", "t3")
	assert.Empty(t, holders())

	// what the hook leaves alone
	assert.Nil(t, post(tokA, sidA, "Bash", "t4", "go test ./one/pkg")["refuse"], "a command that matches nothing")
	assert.Nil(t, post(tokA, sidA, "Read", "t5", heavy)["refuse"], "another tool")
	assert.Empty(t, holders())
	sidC := "eeeeeeee-13645-c000-0000-000000000003"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sidC, AgentType: "codex", AgentName: "Codex", WorkingDir: "/w"}))
	members["codex-"+sidC] = "Agent C"
	tokC := agentToken(t, h, sidC, "codex-"+sidC)
	assert.Nil(t, post(tokC, sidC, "Bash", "t6", heavy)["refuse"], "the refusal is the Claude CLI's answer: another agent is not held")
	assert.Empty(t, holders(), "and claims nothing")
	// QA Reviewer 2: even with the machine BUSY a non-Claude agent is neither refused nor queued (it could not read the refusal)
	_, err = mgr.Claim(ctx, "mac-heavy", "Agent A", "explicit")
	require.NoError(t, err)
	assert.Nil(t, post(tokC, sidC, "Bash", "t7", heavy)["refuse"], "a Codex agent's heavy command on a busy machine runs")
	st, _ = mgr.Queue().Status("mac-heavy")
	assert.Empty(t, st.Queue, "and does not join the line")
	// the command cap: a command over 64 KB is never read (a hostile one costs the server nothing)
	require.NoError(t, mgr.Queue().Release("mac-heavy", "Agent A"))
	assert.Nil(t, post(tokB, sidB, "Bash", "t8", strings.Repeat("x", 70<<10)+" ; go test ./...")["refuse"])
	assert.Empty(t, holders(), "an oversized command claims nothing")
}

func TestASessionThatEndsGivesItsHeavySlotBack(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	mgr, _ := resources.Open(resources.Options{})
	require.NoError(t, mgr.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Match: []string{"go test ./..."}}))
	sid := "eeeeeeee-13645-d000-0000-000000000004"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w"}))
	h.SetResourceHook(resources.NewHook(mgr, resources.HookOptions{Agent: func(context.Context, string) (string, bool) { return "Echo", true }}))
	tok := agentToken(t, h, sid, "claude-"+sid)
	body, _ := json.Marshal(map[string]any{"session_id": sid, "tool_use_id": "t1", "tool_name": "Bash", "tool_input": map[string]any{"command": "go test ./..."}})
	req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/x/pending-tool", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(store.SessionTokenHeader, tok)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	st, _ := mgr.Queue().Status("mac-heavy")
	require.Len(t, st.Holders, 1)
	h.notePendingToolEvent(sid, "session_end", "")
	st, _ = mgr.Queue().Status("mac-heavy")
	assert.Empty(t, st.Holders)
}
