package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GET /api/away is the person's alone and answers with counts of what happened since a time (#17537).
func TestAwayAnswersThePersonWithCountsAndNoOneElse(t *testing.T) {
	e := newReviewEnv(t, true) // one task was completed by Alice just now
	serve := func(person bool) *httptest.Server {
		r := chi.NewRouter()
		r.Get("/api/away", func(w http.ResponseWriter, req *http.Request) {
			if person {
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
			}
			e.h.Away(w, req)
		})
		s := httptest.NewServer(r)
		t.Cleanup(s.Close)
		return s
	}
	person, agent := serve(true), serve(false)
	ago := func(d time.Duration) string { return "?since=" + time.Now().Add(-d).UTC().Format(time.RFC3339) }
	get := func(base, query string) (int, map[string]any) {
		code, out := getActivityPath(t, base, "/api/away", query)
		return code, out
	}

	code, out := get(person.URL, ago(time.Hour))
	require.Equal(t, http.StatusOK, code, out)
	assert.EqualValues(t, 1, out["tasks_done"])
	assert.EqualValues(t, 0, out["goals_done"])
	assert.NotContains(t, out, "title", "counts only")

	code, out = get(person.URL, ago(72*time.Hour))
	require.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, out["since"], time.Now().Add(-24*time.Hour).UTC().Format("2006-01-02"), "three days is cut to a day")

	code, _ = get(person.URL, "")
	assert.Equal(t, http.StatusBadRequest, code, "a time is needed")
	code, _ = get(person.URL, "?since="+time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	assert.Equal(t, http.StatusBadRequest, code, "not a time in the future")
	code, _ = get(agent.URL, ago(time.Hour))
	assert.Equal(t, http.StatusForbidden, code, "an agent is refused")
}
