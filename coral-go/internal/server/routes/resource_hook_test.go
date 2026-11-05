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
	assert.Nil(t, post(tokC, sidC, "Bash", "t6", heavy)["refuse"], "a Codex on a free machine runs the command (#13647)")
	assert.Equal(t, []string{"Agent C"}, holders(), "and holds the slot meanwhile")
	h.notePendingToolEvent(sidC, "tool_use", "t6")
	assert.Empty(t, holders())
	// QA Reviewer 2 (#13645) said a non-Claude agent is neither refused nor queued; since #13647 a Codex agent is held like Claude's, so on a BUSY machine it is refused and joins the line, and a CLI that ran the
	// held command anyway gives its waiting place back when the call ends
	_, err = mgr.Claim(ctx, "mac-heavy", "Agent A", "explicit")
	require.NoError(t, err)
	refuseC, _ := post(tokC, sidC, "Bash", "t7", heavy)["refuse"].(string)
	assert.Contains(t, refuseC, "number 1 in line", "a Codex agent's heavy command on a busy machine is held")
	st, _ = mgr.Queue().Status("mac-heavy")
	require.Len(t, st.Queue, 1, "and joins the line")
	h.notePendingToolEvent(sidC, "tool_use", "t7") // the CLI ran it anyway
	st, _ = mgr.Queue().Status("mac-heavy")
	assert.Empty(t, st.Queue, "its waiting place goes when the call ends")
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

// #13647: a Codex agent's shell command is held like Claude's, by the live session's agent type (not its name), for the shell tool names Codex's hooks use and only when the command is one plain string; an argument
// list is not joined and read, another tool is untouched, and Claude's other tool names stay untouched.
func TestACodexShellCommandIsHeldLikeClaudesAndAnArgumentListIsNotRead(t *testing.T) {
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	mgr, err := resources.Open(resources.Options{AgeStep: -1})
	require.NoError(t, err)
	require.NoError(t, mgr.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Match: []string{"go test ./..."}}))
	sidX, sidY := "eeeeeeee-13647-a000-0000-000000000001", "eeeeeeee-13647-b000-0000-000000000002"
	members := map[string]string{}
	for sid, c := range map[string][2]string{sidX: {"codex", "Codex X"}, sidY: {"codex", "Codex Y"}} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: c[0], AgentName: c[1], WorkingDir: "/w"}))
		members[c[0]+"-"+sid] = c[1]
	}
	h.SetResourceHook(resources.NewHook(mgr, resources.HookOptions{Agent: func(_ context.Context, name string) (string, bool) { m, ok := members[name]; return m, ok }}))
	tokX, tokY := agentToken(t, h, sidX, "codex-"+sidX), agentToken(t, h, sidY, "codex-"+sidY)
	post := func(tok, sid, tool, id string, input map[string]any) map[string]any {
		body, _ := json.Marshal(map[string]any{"session_id": sid, "tool_use_id": id, "tool_name": tool, "tool_input": input})
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/x/pending-tool", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out
	}
	holders := func() int { st, _ := mgr.Queue().Status("mac-heavy"); return len(st.Holders) }
	const heavy = "cd coral-go && SECRET=hunter2 go test ./... | tail"

	assert.Nil(t, post(tokX, sidX, "shell", "c1", map[string]any{"command": []any{"bash", "-lc", heavy}})["refuse"], "an argument list is not read: it runs")
	assert.Zero(t, holders(), "and claims nothing")
	assert.Nil(t, post(tokX, sidX, "apply_patch", "c2", map[string]any{"command": heavy})["refuse"], "another tool is untouched")
	assert.Zero(t, holders())
	assert.Nil(t, post(tokX, sidX, "exec_command", "c3", map[string]any{"cmd": heavy})["refuse"], "a plain string in cmd is read: a free machine runs it")
	assert.Equal(t, 1, holders())
	out := post(tokY, sidY, "Bash", "c4", map[string]any{"command": heavy})
	refuse, _ := out["refuse"].(string)
	assert.Contains(t, refuse, "number 1 in line", "a second Codex is held")
	assert.NotContains(t, refuse, "hunter2")
	h.notePendingToolEvent(sidX, "tool_use", "c3")
	assert.Equal(t, 1, holders(), "the slot goes to the one waiting")
}
