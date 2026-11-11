package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #15715 (generation 11): the owner signed in at the self-hosted Hub imports a team from a folder on a remote computer (a read-only parse; nothing is written). The remote bounds the folder exactly as it does for
// a person at that computer, so the stamp widens nothing: a relative path, the home folder and a sensitive folder are refused even for the owner. A script with the Hub's key, a forged stamp and a Hub with no
// secret are still refused.
func TestTheOwnerAtTheHubImportsATeamFromAFolderOnARemoteWithinTheSameBoundsAndNobodyElseCan(t *testing.T) {
	h := newSystemHandlerForTest(t)
	dir := newTeamDir(t)
	home := t.TempDir() // a home of its own: the sensitive folder below really exists, so its 400 is the refusal and not a missing folder (Security INFO #15716)
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	sensitive := filepath.Join(home, ".ssh")
	require.NoError(t, os.MkdirAll(sensitive, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(sensitive, "SKILL.md"), []byte("---\nname: Not Imported\n---\nsecret"), 0o644))
	mount := func(rr chi.Router) {
		rr.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "hub_owner_routes": hubowner.RoutesVersion})
		})
		rr.Post("/api/teams/import", h.ImportTeam)
	}
	imp := func(w *stampWorld, path string, mutate func(*http.Request)) (int, map[string]any) {
		body, _ := json.Marshal(map[string]string{"path": path})
		req, _ := http.NewRequest("POST", w.hub.URL+"/api/remote/ssh-box/api/teams/import", bytes.NewReader(body))
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
	code, out := imp(w, dir, func(*http.Request) {})
	require.Equal(t, http.StatusOK, code, "the owner at the Hub imports the team: %v", out)
	assert.Equal(t, []string{"Project Lead", "Backend Dev"}, agentNames(out))

	// the remote's bounds hold for the owner as for anyone: no stamp widens them
	for name, path := range map[string]string{
		"a relative path":                "my-team",
		"the home folder":                home,
		"a sensitive folder that exists": sensitive,
		"a folder that is not":           filepath.Join(dir, "nope"),
		"a network-style path":           `\\host\share\team`,
	} {
		code, out = imp(w, path, func(*http.Request) {})
		assert.Equal(t, http.StatusBadRequest, code, "%s: %v", name, out)
	}

	// a script with the Hub's key (no signed-in session) is refused, and a forged stamp is no better
	code, out = imp(w, dir, func(r *http.Request) { r.Header.Set("Authorization", "Bearer the-hubs-own-api-key") })
	assert.Equal(t, http.StatusForbidden, code, out)
	code, _ = imp(w, dir, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer the-hubs-own-api-key")
		r.Header.Set(hubowner.Header, "v1.1."+strings.Repeat("0", 32)+"."+strings.Repeat("0", 64))
	})
	assert.Equal(t, http.StatusForbidden, code)

	// a Hub that holds no secret signs nothing: the signed-in owner is refused, not let through
	w2 := newStampWorldMount(t, "", integrationSecret, mount)
	*w2.cookie = true
	code, out = imp(w2, dir, func(*http.Request) {})
	assert.Equal(t, http.StatusForbidden, code, out)
}

// Security's INFO on #15714: a private mark set by the Hub's signed-in owner says so.
func TestAPrivateMarkSaysWhoSetIt(t *testing.T) {
	as := func(kind string) *http.Request {
		r := httptest.NewRequest(http.MethodPut, "/api/artifacts/x/private", nil)
		return r.WithContext(context.WithValue(r.Context(), callerKindKey{}, kind))
	}
	assert.Equal(t, "Operator via Hub", privateMarkBy(as(callerHubOwner)))
	assert.Equal(t, "Operator", privateMarkBy(as(callerDashCookie)))
	assert.Equal(t, "Operator", privateMarkBy(as(callerAPIKey)))
}
