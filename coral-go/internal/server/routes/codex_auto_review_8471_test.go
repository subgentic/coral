package routes

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// The hook's unchanged mapping of a real auto-run sequence. Inspect the row at
// the PermissionRequest itself: a later PostToolUse must not hide a false edge.
func TestCodex8471AutoRunNeverRaisesNeedsInput(t *testing.T) {
	r := newCodexRig(t)
	fixture := filepath.Join("testdata", "codex_auto_review_8471")
	contextLine, err := os.ReadFile(filepath.Join(fixture, "turn-context.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(r.rollout, contextLine, 0600))
	r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	for _, typ := range []string{"PreToolUse", "PermissionRequest", "PostToolUse"} {
		raw, err := os.ReadFile(filepath.Join(fixture, typ+".json"))
		require.NoError(t, err)
		var hook map[string]any
		require.NoError(t, json.Unmarshal(raw, &hook))
		tool := hook["tool_name"].(string)
		if typ == "PreToolUse" {
			r.h.pending.set(r.sid, pendingTool{ToolUseID: hook["tool_use_id"].(string), ToolName: tool, At: time.Now()})
			continue
		}
		event := map[string]any{"event_type": "tool_use", "summary": "Ran: printf CT8471_AUTO_RUN", "tool_name": tool, "tool_use_id": hook["tool_use_id"]}
		if typ == "PermissionRequest" {
			input := hook["tool_input"].(map[string]any)
			event = map[string]any{"event_type": "permission_request", "summary": "Waiting for the user: permission (Bash)", "tool_name": tool, "detail_json": map[string]any{"kind": "permission", "tool_name": tool, "wants": "Wants to run: " + input["command"].(string)}}
		}
		body, err := json.Marshal(event)
		require.NoError(t, err)
		r.post(string(body))
		httpState, wsState := httpAndWSState(t, r.server, r.h, r.sid)
		require.Equal(t, httpState, wsState)
		require.Equal(t, false, httpState["waiting_for_input"], typ)
		ct8471LogWire(t, typ, httpState)
		require.False(t, r.needsInput(), typ+": no Needs you row and no rising waiting edge for the toast")
		events, err := r.h.ts.ListAgentEvents(context.Background(), "cx", 20, &r.sid)
		require.NoError(t, err)
		for _, e := range events {
			require.NotEqual(t, "permission_request", e.EventType, "an auto-review candidate is never a person-facing event")
		}
	}
	require.Eventually(t, func() bool { _, ok := r.h.codexPermissionWatches.Load(r.sid + "|Bash"); return !ok }, time.Second, time.Millisecond)
}

func TestCodex8471UserReviewRemainsAuthoritative(t *testing.T) {
	r := newCodexRig(t)
	require.NoError(t, os.WriteFile(r.rollout, []byte(`{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"user"}}`+"\n"), 0600))
	r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	r.post(`{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","tool_name":"Bash"}}`)
	httpState, wsState := httpAndWSState(t, r.server, r.h, r.sid)
	require.Equal(t, httpState, wsState)
	require.Equal(t, true, httpState["waiting_for_input"])
	ct8471LogWire(t, "UserDialog", httpState)
	require.True(t, r.needsInput(), "a CLI configured to ask the user retains its authoritative hook")
}

func TestCodex8471AutoReviewerEscalationNeedsLiveMenu(t *testing.T) {
	for _, reviewer := range []string{"auto_review", ""} {
		t.Run(reviewer, func(t *testing.T) {
			r := newCodexRig(t)
			ctx := context.Background()
			require.NoError(t, os.WriteFile(r.rollout, []byte(`{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"`+reviewer+`"}}`+"\n"), 0600))
			r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
			term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: r.mock}}
			term.show(displayFixture(t, "approved-working.txt"))
			r.h.terminal = term
			r.h.pending.set(r.sid, pendingTool{ToolUseID: "exec-8471", ToolName: "Bash", At: time.Now()})
			tool := "Bash"
			detail := `{"kind":"permission","tool_name":"Bash","wants":"Wants to run: printf CT8471_AUTO_RUN","call_ids":["exec-8471"]}`
			event := &store.AgentEvent{AgentName: "cx", SessionID: &r.sid, ToolName: &tool, EventType: "permission_request", Summary: "Waiting for the user: permission (Bash)", DetailJSON: &detail}
			require.False(t, r.h.confirmCodexPermission(r.name, "/tmp/project", event, []string{"exec-8471"}))
			require.False(t, r.needsInput(), "Working is not a person-facing wait")
			before := r.h.wsList.kickGen
			term.show(displayFixture(t, "exec-dialog.txt"))
			require.True(t, r.h.confirmCodexPermission(r.name, "/tmp/project", event, []string{"exec-8471"}))
			require.True(t, r.needsInput(), "the real 0.163 approval menu publishes Needs you")
			require.Greater(t, r.h.wsList.kickGen, before, "confirmed wait immediately refreshes the feed used for toasts")
			events, err := r.h.ts.ListAgentEvents(ctx, "cx", 20, &r.sid)
			require.NoError(t, err)
			require.Equal(t, "permission_request", events[0].EventType)
			r.post(`{"event_type":"tool_use","summary":"Ran: printf CT8471_AUTO_RUN","tool_name":"Bash","tool_use_id":"exec-8471"}`)
			require.False(t, r.needsInput(), "completion still resolves the confirmed dialog")
		})
	}
}

func TestCodex8471CompletedCandidateCannotPromoteStaleMenu(t *testing.T) {
	r := newCodexRig(t)
	r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: r.mock}}
	term.show(displayFixture(t, "exec-dialog.txt"))
	r.h.terminal = term
	tool := "Bash"
	detail := `{"kind":"permission","call_ids":["exec-8471"]}`
	event := &store.AgentEvent{AgentName: "cx", SessionID: &r.sid, ToolName: &tool, EventType: "permission_request", Summary: "Waiting", DetailJSON: &detail}
	require.True(t, r.h.confirmCodexPermission(r.name, "/tmp/project", event, []string{"exec-8471"}))
	require.False(t, r.needsInput(), "no matching live call: a stale menu cannot reopen a finished request")
}

func TestCodex8471NativeStatePrecedesScreenFallback(t *testing.T) {
	r := newCodexRig(t)
	require.NoError(t, os.WriteFile(r.rollout, []byte(`{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"auto_review"}}`+"\n"), 0600))
	r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: r.mock}}
	term.show(displayFixture(t, "exec-dialog.txt"))
	r.h.terminal = term
	backend := &wstBackend{replay: []byte("\x1b]7501;state=working:app=codex\x1b\\")}
	r.h.backend = backend
	r.h.pending.set(r.sid, pendingTool{ToolUseID: "exec-8471", ToolName: "Bash", At: time.Now()})
	tool := "Bash"
	detail := `{"kind":"permission","call_ids":["exec-8471"]}`
	event := &store.AgentEvent{AgentName: "cx", SessionID: &r.sid, ToolName: &tool, EventType: "permission_request", Summary: "Waiting", DetailJSON: &detail}
	require.False(t, r.h.confirmCodexPermission(r.name, "/tmp/project", event, []string{"exec-8471"}))
	require.False(t, r.needsInput(), "the native working signal overrides a stale visible menu")
	term.show("no menu available")
	backend.mu.Lock()
	backend.replay = []byte("\x1b]7501;state=blocked:app=codex\x1b\\")
	backend.mu.Unlock()
	require.True(t, r.h.confirmCodexPermission(r.name, "/tmp/project", event, []string{"exec-8471"}))
	require.True(t, r.needsInput(), "the CLI's explicit blocked signal needs no screen")
}

// The artifact's Node check feeds these real HTTP/WS state fields through the
// existing frontend attention and toast functions, without a browser suite.
func ct8471LogWire(t *testing.T, step string, state map[string]any) {
	t.Helper()
	row := map[string]any{"session_id": "8471", "name": "codex-8471", "agent_type": "codex", "waiting_kind": "permission", "waiting_since": "8471-request"}
	for k, v := range state {
		row[k] = v
	}
	raw, err := json.Marshal(map[string]any{"step": step, "row": row})
	require.NoError(t, err)
	t.Logf("CT8471_WIRE %s", raw)
}
