package routes

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/internal/sessionstate"
	"github.com/subgentic/coral/internal/store"
)

// #13705, QA Reviewer 2: what the stuck-holder watch reads is the derived session state. Only the agent's OWN request (a permission or approval prompt it raised) is a prompt; Coral's own held notice, which also sets
// NeedsInput, is not; a turn that goes on is not a prompt.
func TestResourceSignalIsAPromptOnlyForTheAgentsOwnOpenRequest(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "eeeeeeee-13705-a000-0000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "Agent A", WorkingDir: "/w"}))
	add := func(typ, summary, detail string) {
		ev := &store.AgentEvent{AgentName: "Agent A", SessionID: &sid, EventType: typ, Summary: summary}
		if detail != "" {
			ev.DetailJSON = &detail
		}
		_, err := h.ts.InsertAgentEvent(ctx, ev)
		require.NoError(t, err)
	}
	add("prompt_submit", "User submitted prompt", "")
	add("notification", sessionstate.HeldInputSummary, "") // Coral's own held notice: NeedsInput, but not the agent's request
	st := h.deriveSingleSessionState(ctx, sid, 0)
	require.True(t, st.NeedsInput, "the held notice sets NeedsInput")
	require.False(t, st.OwnRequest)
	kind, _ := h.ResourceSignal(sid)
	assert.Empty(t, kind, "Coral's own notice is not a holder stuck at the agent's prompt")

	add("permission_request", "Waiting for the user: permission (Bash)", `{"kind":"permission","tool_name":"Bash"}`)
	st = h.deriveSingleSessionState(ctx, sid, 0)
	require.True(t, st.NeedsInput)
	require.True(t, st.OwnRequest)
	kind, since := h.ResourceSignal(sid)
	assert.Equal(t, resources.SignalPrompt, kind, "the agent's own permission request is a prompt")
	assert.False(t, since.IsZero())

	add("tool_use", "Bash", "") // the request was answered and the call ran: the turn goes on
	kind, _ = h.ResourceSignal(sid)
	assert.Empty(t, kind, "an answered prompt is not a prompt")
	kind, _ = h.ResourceSignal("no-such-session")
	assert.Empty(t, kind, "a session Coral cannot read is left alone")
}
