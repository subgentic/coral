package routes

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #9337: the sidebar polls a board's status every few seconds and it is usually unchanged. The status carries a validator of itself without its
// clock, and a request that names it gets 304 with no body.
func TestBoardStatusAnswers304ToTheValidatorAndFreshWhenChanged(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "poll"
	sid := uuid.NewString()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: "dev", AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
	_, err := h.bs.Subscribe(ctx, team, "dev", "Developer", "claude-"+sid, nil, "all")
	require.NoError(t, err)
	terminal.addSession("claude-"+sid, "/tmp")
	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "dev", SessionID: &sid, EventType: "stop"})
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Get("/api/board/{project}/status", h.TeamAvailability)
	get := func(inm string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/board/poll/status", nil)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	first := get("")
	require.Equal(t, 200, first.Code, first.Body.String())
	tag := first.Header().Get("ETag")
	require.NotEmpty(t, tag)
	assert.Equal(t, tag, first.Header().Get("X-Coral-Validator"), "through the Hub, which drops ETag")
	assert.Contains(t, first.Body.String(), "observed_at")

	time.Sleep(1100 * time.Millisecond) // sleep-ok: the clock in the body must have moved on for this to show anything
	again := get("")
	require.Equal(t, 200, again.Code)
	assert.Equal(t, tag, again.Header().Get("ETag"), "the validator does not depend on the status's own clock")

	nm := get(tag)
	assert.Equal(t, 304, nm.Code)
	assert.Empty(t, nm.Body.String())
	assert.Equal(t, tag, nm.Header().Get("ETag"))
	assert.Equal(t, 200, get(`W/"other"`).Code, "a validator that is not the status's gets the whole status")

	// something changes: the validator changes, and the old one gets the new status
	_, err = h.bs.CreateTask(ctx, team, "New work", "", "medium", "lead", "dev")
	require.NoError(t, err)
	changed := get(tag)
	require.Equal(t, 200, changed.Code, "an old validator after a change is answered in full")
	assert.NotEqual(t, tag, changed.Header().Get("ETag"))
	assert.Equal(t, 304, get(changed.Header().Get("ETag")).Code)
}
