package routes

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

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
