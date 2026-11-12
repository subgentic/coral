package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/pkg/hubowner"
)

// #15713 (generation 10): the owner signed in at the self-hosted Hub marks an artifact private to the manager on a remote computer, and clears the mark. Reason: the owner manages who reads their files
// (a guide never reads a private one) and has no other way to do it on a remote computer. A script with the Hub's key, a forged stamp and a Hub with no secret are still refused.
func TestTheOwnerAtTheHubMarksAnArtifactPrivateOnARemoteAndNobodyElseCan(t *testing.T) {
	cfg := config.Load(t.TempDir())
	_, h, _, _ := setupSessionsTestServerWithConfig(t, cfg)
	id := strings.Repeat("ab", 32)
	objs := filepath.Join(cfg.CoralDir(), "artifacts", "objects")
	require.NoError(t, os.MkdirAll(objs, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(objs, id), []byte("hello"), 0o644))
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Put("/api/artifacts/{id}/private", h.artifactPrivateRoute)
	}
	mark := func(w *stampWorld, private bool, mutate func(*http.Request)) (int, map[string]any) {
		body := `{"private":false}`
		if private {
			body = `{"private":true}`
		}
		req, _ := http.NewRequest("PUT", w.hub.URL+"/api/remote/ssh-box/api/artifacts/"+id+"/private", strings.NewReader(body))
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
	isPrivate := func() bool {
		p, err := h.bs.ArtifactPrivate(context.Background(), id)
		require.NoError(t, err)
		return p
	}

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	code, out := mark(w, true, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub marks it private: %v", out)
	assert.True(t, isPrivate())
	code, out = mark(w, false, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "and clears the mark: %v", out)
	assert.False(t, isPrivate())

	// a script with the Hub's key (no signed-in session) is refused, and a forged stamp is no better
	code, out = mark(w, true, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	code, _ = mark(w, true, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)
	assert.False(t, isPrivate())

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = mark(w2, true, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.False(t, isPrivate())
}
