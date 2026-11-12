package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #15697: the self-hosted Hub's signed-in owner pauses and resumes an agent's notices on a remote computer. The Hub signs this request (generation 8 of the stamp list); the remote then sees a person. A script
// holding the Hub's key, or a Hub that holds no secret, is still refused, and an agent is refused everywhere.
func TestTheOwnerAtTheHubPausesAndResumesNoticesOnARemoteAndNobodyElseCan(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	sid := "eeeeeeee-1387-1b00-0000-000000015697"
	name := "claude-" + sid
	terminal.addSession(name, "/w")
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "echo", WorkingDir: "/w"}))
	t.Cleanup(func() { ptymanager.ResumeNotices(sid) })
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { // the remote says which generation of the list it accepts, as the real one does: the Hub signs a route only for a remote that lists it
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Post("/api/sessions/live/{name}/notices/pause", h.PauseNotices)
		rr.Post("/api/sessions/live/{name}/notices/resume", h.ResumeNotices)
	}
	body := `{"agent_type":"claude","session_id":"` + sid + `"}`
	send := func(w *stampWorld, which string, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/sessions/live/echo/notices/"+which, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		mutate(req)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		b, _ := io.ReadAll(resp.Body)
		_ = json.Unmarshal(b, &out)
		return resp.StatusCode, out
	}

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	code, out := send(w, "pause", func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub pauses: %v", out)
	assert.Equal(t, true, out["notices_paused"])
	assert.True(t, ptymanager.NoticesHeld(sid))
	code, out = send(w, "resume", func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "and resumes: %v", out)
	assert.False(t, ptymanager.NoticesHeld(sid))

	// a script with the Hub's key (no signed-in session) is refused, and a forged stamp is no better
	code, out = send(w, "pause", func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.False(t, ptymanager.NoticesHeld(sid))
	code, _ = send(w, "pause", func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)
	assert.False(t, ptymanager.NoticesHeld(sid))

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = send(w2, "pause", func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.False(t, ptymanager.NoticesHeld(sid))
}
