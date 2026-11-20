package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	setreg "github.com/subgentic/coral/internal/settings"
)

// #19996 (goal #265): sharing an artifact to a Google Doc is an experimental feature, off for every install. Slice 1: the switch, its refusal and the status route.
func TestGdocShareIsOffByDefaultRefusesWhileOffAndReportsItsState(t *testing.T) {
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	r := chi.NewRouter()
	h.RegisterGdocShare(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	ctx := context.Background()

	get := func() (int, map[string]any) {
		resp, err := http.Get(srv.URL + "/api/gdoc/status")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	assert.False(t, setreg.Bool(map[string]string{}, setreg.GdocShare), "off for every install")
	status, out := get()
	assert.Equal(t, 200, status, "%v", out)
	assert.Equal(t, false, out["enabled"], "the status route answers while off, and says off")

	// every other route of the feature is refused while off, with the message that names the setting
	resp, err := http.Post(srv.URL+"/api/artifacts/abc/gdoc/share", "application/json", nil)
	require.NoError(t, err)
	var refused map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&refused)
	resp.Body.Close()
	assert.Equal(t, 403, resp.StatusCode, "%v", refused)
	assert.Equal(t, GdocShareOffMessage, refused["error"])
	assert.Contains(t, GdocShareOffMessage, "Share to Google Docs (experimental)")

	require.NoError(t, ss.SetSetting(ctx, setreg.GdocShare, "true"))
	_, out = get()
	assert.Equal(t, true, out["enabled"])
	for k := range out {
		assert.NotContains(t, []string{"token", "access_token", "refresh_token", "client_secret"}, k, "the status never carries a credential")
	}
}
