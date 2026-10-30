package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/operatortouch"
)

// #11225: the Operator's touches are written where the Operator acts: the Stop button (Escape), the wake route. A person's request only; an agent's token or a bare local caller is no touch.
func touchesOf(t *testing.T, h *SessionsHandler, team string) *board.Touches {
	t.Helper()
	now := time.Now().UTC()
	got, err := h.bs.OperatorTouches(context.Background(), team, now.Add(-time.Hour).Format(time.RFC3339), now.Add(time.Hour).Format(time.RFC3339))
	require.NoError(t, err)
	return got
}

func withCaller(kind string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if kind != "" {
			r = r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind))
		}
		next.ServeHTTP(w, r)
	})
}

func touchRig(t *testing.T, team string) (*wakeRig, string) {
	r := newWakeRig(t)
	teamAsleepAfterCrash(t, r, team)
	ss := r.ss
	r.h.SetTouches(operatortouch.New(r.h.bs, func(ctx context.Context, sessionID string) (string, string, bool) {
		ls, err := ss.GetLiveSession(ctx, sessionID)
		if err != nil || ls == nil || ls.BoardName == nil || *ls.BoardName == "" {
			return "", "", false
		}
		return *ls.BoardName, ls.AgentName, true
	}))
	return r, sid(1)
}

func TestAPersonsWakeAndStopAreTouchesAndAnAgentsAreNot(t *testing.T) {
	const team = "team-11225"
	r, id := touchRig(t, team)
	h := r.h

	router := func(kind string) http.Handler {
		rt := chi.NewRouter()
		rt.Post("/api/sessions/{sessionID}/wake", h.WakeSession)
		rt.Post("/api/sessions/live/{name}/keys", h.Keys)
		return withCaller(kind, rt)
	}
	// a bare local caller (not a person): the wake happens, no touch
	req := httptest.NewRequest(http.MethodPost, "/api/sessions/"+id+"/wake", nil)
	router("").ServeHTTP(httptest.NewRecorder(), req)
	assert.Zero(t, touchesOf(t, h, team).Kinds.Total(), "automation is not the Operator")

	// the person: put it back to sleep and wake it from the dashboard
	_, err := h.db.ExecContext(context.Background(), "UPDATE live_sessions SET is_sleeping = 1 WHERE session_id = ?", id)
	require.NoError(t, err)
	req = httptest.NewRequest(http.MethodPost, "/api/sessions/"+id+"/wake", nil)
	router(callerDashCookie).ServeHTTP(httptest.NewRecorder(), req)
	got := touchesOf(t, h, team)
	assert.Equal(t, 1, got.Kinds.Wake, "the Operator's wake")
	require.Len(t, got.Agents, 1)
	assert.Equal(t, "Dev", got.Agents[0].Name)

	// the Stop button: one Escape from a person
	name := naming.SessionName("claude", id)
	body := `{"keys":["Escape"],"agent_type":"claude","session_id":"` + id + `"}`
	rec := httptest.NewRecorder()
	router(callerDashCookie).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/keys", strings.NewReader(body)))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, 1, touchesOf(t, h, team).Kinds.Stop, "the Operator's stop")
	// another key from a person is not a stop
	rec = httptest.NewRecorder()
	router(callerDashCookie).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/keys", strings.NewReader(`{"keys":["Up"],"agent_type":"claude","session_id":"`+id+`"}`)))
	assert.Equal(t, 1, touchesOf(t, h, team).Kinds.Stop)

	// and what the read carries is counts: no text, no ids of messages
	b, _ := json.Marshal(touchesOf(t, h, team))
	assert.NotContains(t, string(b), "Escape")
}
