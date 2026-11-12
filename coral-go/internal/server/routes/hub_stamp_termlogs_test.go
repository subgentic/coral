package routes

import (
	"bytes"
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

// #15720 (generation 13): the owner signed in at the self-hosted Hub deletes the terminal logs of ended agents on a remote computer. The body is the count and size shown, never a file name, so the request cannot
// reach a live session's log or any other file: the remote deletes only what it finds itself. A script with the Hub's key, a forged stamp and a Hub with no secret are refused and nothing is deleted.
func TestTheOwnerAtTheHubDeletesEndedTerminalLogsOnARemoteAndNobodyElseCan(t *testing.T) {
	g := newLogsRig(t)
	g.session(idEnded1, "claude", true, false, false)
	g.session(idLive, "claude", false, false, false)
	g.session(idSleeping, "claude", true, true, false)
	ended := g.log("claude", idEnded1, 10)
	live := g.log("claude", idLive, 20)
	asleep := g.log("claude", idSleeping, 30)
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		g.h.RegisterTerminalLogs(rr)
	}
	del := func(w *stampWorld, body string, mutate func(*http.Request)) (int, map[string]any) {
		req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/system/terminal-logs/delete-ended", bytes.NewReader([]byte(body)))
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
	shown := `{"count":1,"bytes":10}` // what the owner was shown: one ended agent's log of 10 bytes

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	// the owner is not yet signed in: a script with the Hub's key is refused, and a forged stamp is no better
	code, out := del(w, shown, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	code, _ = del(w, shown, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)
	assert.True(t, g.exists(ended), "a refused request deleted nothing")

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = del(w2, shown, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.True(t, g.exists(ended))

	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	// a count or size that is not what is there deletes nothing (409), and a file name in the body is no part of the request
	code, out = del(w, `{"count":2,"bytes":40}`, func(*http.Request) {})
	assert.Equal(t, http.StatusConflict, code, out)
	assert.True(t, g.exists(ended))
	// the owner deletes what was shown. A file name added to the body is not read (the remote works out what to delete itself): it names a live agent's log here, and that log survives
	code, out = del(w, `{"count":1,"bytes":10,"name":"claude_coral_`+idLive+`.log"}`, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub deletes the ended logs: %v", out)
	assert.False(t, g.exists(ended), "the ended agent's log is deleted")
	assert.True(t, g.exists(live), "a live agent's log is never deleted, even when the body names it")
	assert.True(t, g.exists(asleep), "a sleeping agent's log is kept: wake needs it")
}
