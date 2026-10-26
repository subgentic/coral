package routes

import (
	"context"
	"encoding/json"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
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
			r.h.pending.set(r.sid, pendingTool{ToolUseID: hook["tool_use_id"].(string), ToolName: tool})
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
		require.False(t, r.needsInput(), typ+": no Needs you row and no rising waiting edge for the toast")
		events, err := r.h.ts.ListAgentEvents(context.Background(), "cx", 20, &r.sid)
		require.NoError(t, err)
		for _, e := range events {
			require.NotEqual(t, "permission_request", e.EventType, "an auto-review candidate is never a person-facing event")
		}
	}
}
