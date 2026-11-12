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

	"github.com/subgentic/coral/pkg/hubowner"
)

// #15729 (generation 14): the owner signed in at the self-hosted Hub acknowledges the dry run for artifact retention on a remote computer. No body is read; the remote writes its own clock into its own setting.
// A script with the Hub's key, a forged stamp and a Hub with no secret are refused and nothing is written.
func TestTheOwnerAtTheHubAcknowledgesArtifactRetentionOnARemoteAndNobodyElseCan(t *testing.T) {
	rig := newPruneRig(t)
	ctx := context.Background()
	require.NoError(t, rig.h.ss.SetSetting(ctx, RetentionDaysSetting, "7"))
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Post("/api/artifacts/retention/ack", rig.h.retentionAckRoute)
	}
	ack := func(w *stampWorld, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/artifacts/retention/ack", strings.NewReader(`{}`))
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
	acked := func() string {
		s, err := rig.h.ss.GetSettings(ctx)
		require.NoError(t, err)
		return s[RetentionAckAtKey]
	}

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	// not signed in: a script with the Hub's key is refused, and a forged stamp is no better
	code, out := ack(w, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	code, _ = ack(w, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)
	assert.Empty(t, acked(), "a refused request wrote nothing")

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = ack(w2, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.Empty(t, acked())

	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	code, out = ack(w, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub acknowledges the dry run: %v", out)
	assert.NotEmpty(t, out["acknowledged_at"])
	assert.Equal(t, out["acknowledged_at"], acked())

	// the remote's own check still holds for the owner: with retention off there is nothing to acknowledge
	require.NoError(t, rig.h.ss.SetSetting(ctx, RetentionDaysSetting, "0"))
	code, out = ack(w, func(*http.Request) {})
	assert.Equal(t, http.StatusBadRequest, code, out)
}
