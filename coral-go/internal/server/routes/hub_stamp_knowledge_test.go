package routes

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #15717 (generation 12): the owner signed in at the self-hosted Hub runs a team's daily knowledge on a remote computer: the switch, whether an update applies by itself, accepting the waiting update and taking
// it back. The bodies are booleans and ids; the remote builds every change itself. A script with the Hub's key, a forged stamp and a Hub with no secret are still refused, on all four.
func TestTheOwnerAtTheHubRunsATeamsDailyKnowledgeOnARemoteAndNobodyElseCan(t *testing.T) {
	r := newDailyRig(t)
	h := r.h
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Get("/api/teams/detail/{name}/daily-knowledge", h.DailyKnowledgeStatus)
		rr.Put("/api/teams/detail/{name}/daily-knowledge", h.SetDailyKnowledge)
		rr.Put("/api/teams/detail/{name}/daily-knowledge/auto-apply", h.SetDailyKnowledgeAutoApply)
		rr.Post("/api/teams/detail/{name}/daily-knowledge/accept", h.AcceptDailyKnowledge)
		rr.Post("/api/teams/detail/{name}/daily-knowledge/revert", h.RevertDailyKnowledge)
	}
	type call struct{ method, suffix, body string }
	calls := []call{
		{"PUT", "", `{"enabled":true}`},
		{"PUT", "/auto-apply", `{"enabled":true}`},
		{"POST", "/accept", `{"candidate":"c1"}`},
		{"POST", "/revert", `{"previous":"p1"}`},
	}
	do := func(w *stampWorld, c call, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest(c.method, w.hub.URL+"/api/remote/ssh-box/api/teams/detail/alpha/daily-knowledge"+c.suffix, strings.NewReader(c.body))
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
	// the owner gets past the person gate on all four (the rig's team has no job and no waiting update, so the switch and the two decisions answer from their own checks, and the auto-apply switch really changes)
	for _, c := range calls {
		code, out := do(w, c, func(*http.Request) {})
		assert.NotEqual(t, http.StatusForbidden, code, "the owner at the Hub on %s %s: %v", c.method, c.suffix, out)
	}
	code, out := do(w, calls[2], func(*http.Request) {})
	assert.Equal(t, "no_candidate", out["code"], "accept reaches the remote's own check: %d %v", code, out)
	code, out = do(w, calls[3], func(*http.Request) {})
	assert.Equal(t, "nothing_to_revert", out["code"], "revert too: %d %v", code, out)
	assert.True(t, background.AutoApplyOn(h.cfg.CoralDir(), "alpha"), "the owner switched automatic apply on")
	code, out = do(w, call{"PUT", "/auto-apply", `{"enabled":false}`}, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, out)
	assert.False(t, background.AutoApplyOn(h.cfg.CoralDir(), "alpha"))

	// a script with the Hub's key (no signed-in session) is refused, and a forged stamp is no better; nothing changes
	for _, c := range calls {
		code, out := do(w, c, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
		assert.Equal(t, http.StatusForbidden, code, "key alone on %s %s: %v", c.method, c.suffix, out)
		code, _ = do(w, c, func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
			r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
		})
		assert.Equal(t, http.StatusForbidden, code, "forged stamp on %s %s", c.method, c.suffix)
	}
	assert.False(t, background.AutoApplyOn(h.cfg.CoralDir(), "alpha"), "a refused request changed nothing")

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	for _, c := range calls {
		code, out := do(w2, c, func(*http.Request) {})
		assert.Equal(t, http.StatusForbidden, code, "no secret on %s %s: %v", c.method, c.suffix, out)
	}
	assert.False(t, background.AutoApplyOn(h.cfg.CoralDir(), "alpha"))
}
