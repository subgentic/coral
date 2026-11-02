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

// The Operator turns an agent's auto-sleep off and on; the exact target is checked, and the body must say which.
func TestAutoSleepOptOutSwitch(t *testing.T) {
	r := newSleepRig(t)
	rt := chi.NewRouter()
	rt.Post("/api/sessions/live/{name}/auto-sleep", r.h.AutoSleepOpt)
	call := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+r.name+"/auto-sleep", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		rt.ServeHTTP(rec, req)
		return rec.Code
	}
	sid := `"session_id":"` + r.sid + `","agent_type":"claude"`
	assert.Equal(t, http.StatusBadRequest, call(`{`+sid+`}`), "off is required")
	assert.Equal(t, http.StatusBadRequest, call(`{"off":true}`), "a session is required")
	assert.Equal(t, http.StatusBadRequest, call(`{"session_id":"`+r.sid+`","off":true}`), "the exact target names its type")
	assert.Equal(t, http.StatusOK, call(`{`+sid+`,"off":true}`))
	st, err := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	require.NoError(t, err)
	assert.True(t, st.Off)
	ls := r.pass(t) // an opted-out agent is not put to sleep
	assert.Equal(t, 0, ls.IsSleeping)
	assert.Equal(t, http.StatusOK, call(`{`+sid+`,"off":false}`))
	st, _ = r.ss.AutoSleepStateOf(r.ctx, r.sid)
	assert.False(t, st.Off)
	ls = r.pass(t)
	assert.Equal(t, 1, ls.IsSleeping, "back under the rule, it sleeps")
}
