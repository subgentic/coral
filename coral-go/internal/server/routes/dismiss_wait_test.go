package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (r *holdRig) dismiss(sessionID string) *httptest.ResponseRecorder {
	r.t.Helper()
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/dismiss-wait", r.h.DismissWait)
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/dismiss-wait", bytes.NewBufferString(`{"session_id":"`+sessionID+`","agent_type":"claude"}`))
	rec := httptest.NewRecorder()
	rt.ServeHTTP(rec, req)
	return rec
}

// #11352: the Operator's Dismiss clears a stale "Permission needed": the state, the held-message gate and the Inbox row all follow the events, and nothing is typed to the agent.
func TestDismissWaitClearsAnOpenPermissionAndTypesNothing(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.requestFor("Wants to run: go test ./...")
	require.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	typedBefore := len(r.typed())

	rec := r.dismiss(r.sid)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"dismissed":true`)
	assert.False(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput)
	assert.False(t, r.h.blockedOnBox(ctx, r.name, "claude", r.sid))
	assert.Equal(t, typedBefore, len(r.typed()), "nothing was typed into the agent's terminal")

	rec = r.dismiss(r.sid)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"dismissed":false`, "nothing is open any more")
}

// The exact target: an agent's name with another session's id is refused, not applied to whichever agent the name matches.
func TestDismissWaitRefusesAnotherSessionsId(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.requestFor("Wants to run: ls")
	rec := r.dismiss("bbbbbbbb-6610-4000-8000-000000000002")
	assert.NotEqual(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "the agent's own wait is untouched")
}

// A store failure is answered with a fixed sentence: the database's own words are logged, never sent (QA's SHOULD on #11352, made required).
func TestDismissWaitAnswersAStoreFailureWithAFixedSentence(t *testing.T) {
	r := newHoldRig(t, true)
	r.requestFor("Wants to run: go test ./...")
	_, err := r.h.db.Exec(`CREATE TRIGGER refuse_dismissal BEFORE INSERT ON agent_events WHEN NEW.event_type = 'request_resolved' BEGIN SELECT RAISE(ABORT, 'secret database text: /Users/x/.coral/sessions.db'); END`)
	require.NoError(t, err)

	rec := r.dismiss(r.sid)
	assert.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), "Could not dismiss it. Try again.")
	assert.NotContains(t, rec.Body.String(), "secret database text")
	assert.NotContains(t, rec.Body.String(), "sessions.db")
	assert.True(t, r.h.deriveSingleSessionState(context.Background(), r.sid, 0).NeedsInput, "nothing was cleared")
}

// #11946 (the Operator's bug, and QA's INFO against "one number"): a request the machine cannot clear (an elicitation, an input prompt, a sign-in) is HIDDEN by the Dismiss, and the hiding is kept on the machine,
// per agent and request, so the live row says so (wait_ignored), /api/needs-you leaves the agent out, and every count agrees. The agent's next request is its own. Nothing is typed to the agent.
func TestDismissWaitHidesARequestTheMachineCannotClearAndKeepsItOnTheMachine(t *testing.T) {
	r := newHoldRig(t, true)
	ctx := context.Background()
	r.post(`{"event_type":"permission_request","summary":"Waiting for the user: elicitation","tool_name":"mcp__x","detail_json":{"kind":"elicitation","tool_name":"mcp__x","wants":"Wants to know: which colour"}}`)
	st := r.h.deriveSingleSessionState(ctx, r.sid, 0)
	require.True(t, st.NeedsInput)
	require.Equal(t, "elicitation", st.WaitingKind)
	typedBefore := len(r.typed())

	rec := r.dismiss(r.sid)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"dismissed":true`)
	assert.Contains(t, rec.Body.String(), `"hidden":true`, "it says it hid the row, not that it cleared the wait")
	assert.True(t, r.h.deriveSingleSessionState(ctx, r.sid, 0).NeedsInput, "the agent's own state is untouched: it still waits")
	assert.Equal(t, typedBefore, len(r.typed()), "nothing was typed into the agent's terminal")

	ignored, err := r.h.ss.WaitIgnoredKeys(ctx)
	require.NoError(t, err)
	assert.NotEmpty(t, ignored[r.sid], "the hiding is kept on the machine")
	key := ignored[r.sid]
	assert.Equal(t, key, waitRequestKey(r.h.deriveSingleSessionState(ctx, r.sid, 0)), "it names this request")

	// the live row says so, and what waits for the Operator (the count, the phone push) leaves the agent out
	req := httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil)
	rows, err := r.h.liveSessionRows(req, newPhaseTrace("test"), true)
	require.NoError(t, err)
	var found bool
	for _, row := range rows {
		if row["session_id"] == r.sid {
			found = true
			assert.Equal(t, true, row["wait_ignored"], "the row says the request is hidden")
			assert.Equal(t, true, row["waiting_for_input"], "and that the agent still waits")
		}
	}
	require.True(t, found, "the agent is on the live list")
	items, err := r.h.NeedsYouAgents(req)
	require.NoError(t, err)
	for _, it := range items {
		assert.NotEqual(t, "agent:"+r.sid, it.ID, "the hidden request is not in /api/needs-you")
	}

	// the agent asks something new: a different request, so it is not hidden by the old one
	r.post(`{"event_type":"stop","summary":"Agent stopped"}`)
	r.post(`{"event_type":"permission_request","summary":"Waiting for the user: elicitation","tool_name":"mcp__x","detail_json":{"kind":"elicitation","tool_name":"mcp__x","wants":"Wants to know: and the size?"}}`)
	st2 := r.h.deriveSingleSessionState(ctx, r.sid, 0)
	require.True(t, st2.NeedsInput)
	assert.NotEqual(t, key, waitRequestKey(st2), "a later request has its own key")
}

func TestARequestTheOperatorHidSaysSoOnTheLiveRowAndLeavesNeedsYou(t *testing.T) {
	rows := []map[string]any{
		{"session_id": "a1", "name": "claude-a1", "display_name": "Hidden one", "waiting_for_input": true, "waiting_summary": "Needs input", "waiting_since": "2026-11-02T01:00:00Z", "wait_ignored": true},
		{"session_id": "b2", "name": "claude-b2", "display_name": "Open one", "waiting_for_input": true, "waiting_summary": "Needs input", "waiting_since": "2026-11-02T01:00:00Z"},
	}
	items := needsYouAgentItems(rows, time.Now())
	require.Len(t, items, 1, "the hidden request is not in what waits for the Operator (the count, the phone push)")
	assert.Equal(t, "agent:b2", items[0].ID)
}
