package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The person's Send to an auto-asleep agent wakes it and goes on; to a manual sleeper it still answers that the session is sleeping.
func TestSendWakesAnAutoAsleepAgentButNotAManualSleeper(t *testing.T) {
	send := func(r *sleepRig) int {
		rt := chi.NewRouter()
		rt.Post("/api/sessions/live/{name}/send", r.h.Send)
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/send", strings.NewReader(`{"command":"hello","agent_type":"claude","session_id":"`+r.sid+`"}`))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		return rec.Code
	}
	r := newSleepRig(t)
	r.autoSleep(t)
	assert.Equal(t, http.StatusOK, send(r), "the send was delivered")
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 0, ls.IsSleeping, "and the agent is awake")

	m := newSleepRig(t)
	require.NoError(t, m.ss.SetSessionSleeping(m.ctx, m.sid, true))
	assert.Equal(t, http.StatusConflict, send(m), "a manual sleeper is not woken by a send")
	ls, _ = m.ss.GetLiveSession(m.ctx, m.sid)
	assert.Equal(t, 1, ls.IsSleeping)
}
