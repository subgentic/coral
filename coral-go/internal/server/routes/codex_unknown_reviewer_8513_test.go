package routes

import (
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// #8513: exercise authenticated ingestion, not only the observer in isolation.
// Unknown review must remain a candidate until evidence of a human wait; treating
// only auto_review specially would persist a false rising edge at this boundary.
func TestCodex8513UnknownReviewerNeedsEvidenceAtIngestion(t *testing.T) {
	for _, settings := range []struct{ name, context string }{
		{"no-context", ""},
		{"missing-reviewer", `{"type":"turn_context","payload":{"approval_policy":"on-request"}}`},
		{"empty-reviewer", `{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":""}}`},
		{"future-reviewer", `{"type":"turn_context","payload":{"approval_policy":"on-request","approvals_reviewer":"future"}}`},
	} {
		for _, evidence := range []string{"native", "menu"} {
			name := settings.name + "-" + evidence
			t.Run(name, func(t *testing.T) {
				r := newCodexRig(t)
				// The shared historical rig explicitly uses user review; remove
				// or replace it so none of these cases can inherit that fixture.
				if settings.context == "" {
					require.NoError(t, os.Remove(r.rollout))
				} else {
					require.NoError(t, os.WriteFile(r.rollout, []byte(settings.context+"\n"), 0600))
				}
				r.post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
				term := &approvalFeedTerminal{agentTerm: &agentTerm{mockSessionTerminal: r.mock}}
				term.show(displayFixture(t, "approved-working.txt"))
				r.h.terminal = term
				backend := &wstBackend{}
				r.h.backend = backend
				r.h.pending.set(r.sid, pendingTool{ToolUseID: "exec-8513", ToolName: "Bash", At: time.Now()})
				completed := `{"event_type":"tool_use","summary":"Ran: printf CT8513","tool_name":"Bash","tool_use_id":"exec-8513"}`
				t.Cleanup(func() {
					r.post(completed)
					require.Eventually(t, func() bool { _, ok := r.h.codexPermissionWatches.Load(r.sid + "|Bash"); return !ok }, time.Second, time.Millisecond)
				})
				r.post(`{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","tool_name":"Bash","wants":"Wants to run: printf CT8513"}}`)
				check := func(phase string, want bool) {
					t.Helper()
					httpState, wsState := httpAndWSState(t, r.server, r.h, r.sid)
					require.Equal(t, httpState, wsState)
					require.Equal(t, want, httpState["waiting_for_input"], phase)
					ct8471LogWire(t, name+"/"+phase, httpState)
				}
				check("unconfirmed", false)
				_, watching := r.h.codexPermissionWatches.Load(r.sid + "|Bash")
				require.True(t, watching, "unknown review is observed, not silently discarded")

				// Explicit native working is also negative evidence. Call one
				// observation deterministically instead of waiting for its tick.
				backend.mu.Lock()
				backend.replay = []byte("\x1b]7501;state=working:app=codex\x1b\\")
				backend.mu.Unlock()
				tool := "Bash"
				detail := `{"kind":"permission","tool_name":"Bash","call_ids":["exec-8513"]}`
				candidate := &store.AgentEvent{AgentName: "cx", SessionID: &r.sid, EventType: "permission_request", Summary: "Waiting for the user: permission (Bash)", ToolName: &tool, DetailJSON: &detail}
				require.False(t, r.h.confirmCodexPermission(r.name, "/tmp/project", candidate, []string{"exec-8513"}))
				check("working", false)

				// Then drive the ORIGINAL ingested candidate through either
				// observed Codex signal. Both paths must still publish a wait.
				if evidence == "native" {
					term.show("no approval menu")
					backend.mu.Lock()
					backend.replay = []byte("\x1b]7501;state=blocked:app=codex\x1b\\")
					backend.mu.Unlock()
				} else {
					backend.mu.Lock()
					backend.replay = nil
					backend.mu.Unlock()
					term.show(displayFixture(t, "exec-dialog.txt"))
				}
				r.h.wakeCodexPermissionWatches(r.sid)
				require.Eventually(t, func() bool { _, ok := r.h.codexPermissionWatches.Load(r.sid + "|Bash"); return !ok }, time.Second, time.Millisecond)
				check("confirmed", true)
			})
		}
	}
}
