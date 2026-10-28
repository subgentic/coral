package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #10368 (Mobile #10360): a question an agent asked was lost without a trace when Coral restarted: the CLI that asked is gone, Needs you emptied and the chat showed only the sent line. The request is
// still in the agent's events, so a sleeping agent whose events end in an open request says what it asked; an awake agent's own state says it, and a request that was answered says nothing.
func TestASleepingAgentSaysWhatItAskedBeforeCoralRestarted(t *testing.T) {
	h, _ := sessionFieldsFixture(t)
	ctx := context.Background()
	const sid = "33333333-2222-3333-4444-555555555555"
	require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "asker", WorkingDir: "/tmp/asker"}))
	event := func(typ, summary, detail string) {
		id := sid
		ev := &store.AgentEvent{AgentName: "asker", SessionID: &id, EventType: typ, Summary: summary}
		if detail != "" {
			ev.DetailJSON = &detail
		}
		_, err := h.ts.InsertAgentEvent(ctx, ev)
		require.NoError(t, err)
	}
	asked := func() any {
		w := httptest.NewRecorder()
		h.List(w, httptest.NewRequest("GET", "/api/sessions/live", nil))
		require.Equal(t, 200, w.Code)
		var list []map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &list))
		for _, e := range list {
			if e["session_id"] == sid {
				v, present := e["asked_before_restart"]
				require.True(t, present, "the field is always there, null included")
				return v
			}
		}
		t.Fatal("the agent is not in the list")
		return nil
	}

	event("prompt_submit", "go", "")
	event("permission_request", "Waiting for the user: question (AskUserQuestion)", `{"kind":"question","tool_name":"AskUserQuestion","wants":"Wants to know: which colour for the header"}`)
	event("notification", "Notification: Claude needs your input", "")
	// an awake agent says it with its own state, not as something asked before a restart (it is also not in this list: nothing runs it here)
	evs, err := h.ts.GetSessionStateEvents(ctx, []string{sid})
	require.NoError(t, err)
	assert.Nil(t, askedBeforeRestart(evs[sid], false, false), "awake")

	require.NoError(t, h.ss.SetSessionSleepingFor(ctx, sid, store.SleepReasonCoralStopped)) // Coral stopped, the pty's CLI is gone
	got, _ := asked().(map[string]any)
	require.NotNil(t, got, "a sleeping agent whose events end in an open question says what it asked")
	assert.Equal(t, "Wants to know: which colour for the header", got["text"])
	assert.Equal(t, "question", got["kind"])
	assert.NotEmpty(t, got["at"])

	event("stop", "", "") // answered (or the turn went on): nothing is open
	assert.Nil(t, asked(), "a request that was followed by the agent's turn ending is not asked before the restart")

	// no request at all, or one that is not asked of the person in the chat
	const quiet = "44444444-2222-3333-4444-555555555555"
	require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: quiet, AgentType: "claude", AgentName: "quiet", WorkingDir: "/tmp/quiet"}))
	require.NoError(t, h.ss.SetSessionSleepingFor(ctx, quiet, store.SleepReasonCoralStopped))
	assert.Nil(t, askedBeforeRestart(nil, true, false))
	assert.Nil(t, askedBeforeRestart([]store.AgentEvent{{EventType: "permission_request", Summary: "Waiting for the user: question", CreatedAt: "2026-10-28T10:00:00Z"}}, true, true), "archived")
}
