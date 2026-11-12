package routes

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #15729 (generation 15): the owner signed in at the self-hosted Hub deletes received files no board lists on a remote computer. The body is digests, never a path, and the remote re-checks each one itself, so
// a file a board lists, an agent uploaded or the Operator kept cannot be reached by naming it. A script with the Hub's key, a forged stamp and a Hub with no secret are refused and nothing is deleted.
func TestTheOwnerAtTheHubDeletesUnlistedReceivedFilesOnARemoteAndNobodyElseCan(t *testing.T) {
	rig := newArtifactRig(t)
	bh := &BoardHandler{coralDir: rig.coralDir}
	old := time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339)
	store := func(text, session string) string {
		id, _, err := storeArtifact(rig.coralDir, session, "f.txt", "text/plain", []byte(text))
		require.NoError(t, err)
		return id
	}
	pending := func(id, board string) {
		require.NoError(t, bh.writePendingReceipt("src-1", "msg-"+id[:8], crossTeamArtifactRecord{ID: id, Name: "f.txt", Size: 10, Board: board, OtherBoard: "alpha", Server: "src-1", At: old}))
	}
	unlisted := store("unlisted and expired", "")
	listed := store("listed on a board", "")
	uploaded := store("an agent uploaded this", "s1")
	pending(unlisted, "beta")
	pending(listed, "beta")
	pending(uploaded, "beta")
	require.NoError(t, bh.writeCrossTeamRecord("received", crossTeamArtifactRecord{ID: listed, Name: "f.txt", Size: 10, Board: "gamma", OtherBoard: "alpha", Server: "src-1"}))
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Post("/api/artifacts/received/unlisted/delete", rig.h.deleteUnlistedReceivedRoute)
	}
	del := func(w *stampWorld, ids []string, mutate func(*http.Request)) (int, map[string]any) {
		raw, _ := json.Marshal(map[string]any{"ids": ids})
		req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/artifacts/received/unlisted/delete", bytes.NewReader(raw))
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
	exists := func(id string) bool { _, err := os.Stat(rig.object(id)); return err == nil }
	all := []string{unlisted, listed, uploaded}

	w := newStampWorldMount(t, integrationSecret, integrationSecret, mount)
	// not signed in: a script with the Hub's key is refused, and a forged stamp is no better
	code, out := del(w, all, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	code, _ = del(w, all, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)
	assert.True(t, exists(unlisted), "a refused request deleted nothing")

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = del(w2, all, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
	assert.True(t, exists(unlisted))

	*w.cookie = true // the signed-in dashboard session of the Hub's owner
	code, out = del(w, all, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub deletes the unlisted file: %v", out)
	assert.EqualValues(t, 1, out["deleted"], "only the one the remote itself finds unlisted and expired: %v", out)
	assert.False(t, exists(unlisted), "the unlisted file is gone")
	assert.True(t, exists(listed), "a file a board lists is not reachable by naming it")
	assert.True(t, exists(uploaded), "nor one an agent uploaded")
}
