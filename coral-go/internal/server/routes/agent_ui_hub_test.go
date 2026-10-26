package routes

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #8692 (QA's #8685): a hub reaches a registered server with the server's API key (pkg/hubproxy sends "Authorization: Bearer <key>" and nothing of the browser). The remote agent page's panel reads
// (GET /api/agent/ui and a panel's content and events) and the removal of a panel are the Operator's, so a request of the api_key kind gets them; typing into the agent (a panel event, which wakes it) and
// writing a panel stay as they were: a person at the dashboard, and the agent's own token.
func TestAgentUIPanelsAreReadableThroughTheHubsAPIKey(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "ui-hub", AgentName: "ui-hub", AgentType: "codex", WorkingDir: "/tmp"}))
	_, err := h.db.PutAgentUI(context.Background(), "ui-hub", "demo", "Demo", "<button>Choose</button>")
	require.NoError(t, err)

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if kind := req.Header.Get("X-Test-Kind"); kind != "" {
				req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
			}
			next.ServeHTTP(w, req)
		})
	})
	h.RegisterAgentUI(r)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	call := func(kind, method, path, body string) (int, string) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		if kind != "" {
			req.Header.Set("X-Test-Kind", kind)
		}
		req.Header.Set("Authorization", "Bearer the-servers-key")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(out)
	}

	code, out := call(callerAPIKey, "GET", "/api/agent/ui?session_id=ui-hub", "")
	assert.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, out, `"demo"`)
	code, out = call(callerAPIKey, "GET", "/api/agent/ui/demo/content?session_id=ui-hub", "")
	assert.Equal(t, http.StatusOK, code, out)
	code, out = call(callerAPIKey, "GET", "/api/agent/ui/demo/events?session_id=ui-hub&after=0", "")
	assert.Equal(t, http.StatusOK, code, out)
	code, _ = call(callerAPIKey, "GET", "/api/agent/ui?session_id=nobody", "")
	assert.Equal(t, http.StatusNotFound, code, "an unknown session is still not found")
	code, _ = call(callerAPIKey, "GET", "/api/agent/ui", "")
	assert.Equal(t, http.StatusUnauthorized, code, "no session named: nothing to read")

	// what the key does not get: waking the agent with an event, and writing a panel
	code, out = call(callerAPIKey, "POST", "/api/agent/ui/demo/events?session_id=ui-hub", `{"revision":1,"action":"choose"}`)
	assert.Equal(t, http.StatusUnauthorized, code, out)
	code, out = call(callerAPIKey, "PUT", "/api/agent/ui/demo?session_id=ui-hub", `{"title":"x","html":"<b>x</b>"}`)
	assert.Equal(t, http.StatusUnauthorized, code, out)
	// another kind of caller (a local script, an agent's tool without its token) is no better off than before
	for _, kind := range []string{callerLocalOther, callerAgentNoToken, callerOpen} {
		code, out = call(kind, "GET", "/api/agent/ui?session_id=ui-hub", "")
		assert.Equal(t, http.StatusUnauthorized, code, kind+": "+out)
	}

	code, out = call(callerAPIKey, "DELETE", "/api/agent/ui/demo?session_id=ui-hub", "")
	assert.Equal(t, http.StatusOK, code, out)
}

// The same through the real identity layer, as a hub's request meets it: strict local auth, the server's API key as a Bearer header, no cookie.
func TestAgentUIPanelsThroughTheIdentityLayerWithTheServersKey(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "ui-key", AgentName: "ui-key", AgentType: "codex", WorkingDir: "/tmp"}))
	_, err := h.db.PutAgentUI(context.Background(), "ui-key", "demo", "Demo", "<button>Choose</button>")
	require.NoError(t, err)
	o := NewIdentityObserver(h.db, nil, func(*http.Request) bool { return false })
	o.SetVerifiers(func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer the-servers-key" }, func(r *http.Request) (*http.Request, bool) { return r, false })
	o.SetStrict()
	r := chi.NewRouter()
	r.Use(o.Middleware)
	h.RegisterAgentUI(r)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)
	get := func(auth string) (int, string) {
		req, err := http.NewRequest("GET", server.URL+"/api/agent/ui?session_id=ui-key", nil)
		require.NoError(t, err)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		out, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(out)
	}
	code, out := get("Bearer the-servers-key")
	assert.Equal(t, http.StatusOK, code, out)
	assert.Contains(t, out, `"demo"`)
	code, _ = get("Bearer another-key")
	assert.Equal(t, http.StatusUnauthorized, code, "a key that is not the server's")
	code, _ = get("")
	assert.Equal(t, http.StatusUnauthorized, code, "no credential")
}
