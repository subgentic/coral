package routes

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenInBrowserLocalOperatorAndFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git unavailable")
	}
	_, h, _, ss := setupSessionsTestServer(t)
	root, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	require.NoError(t, consoletest.HiddenCommand("git", "init", "-q", root).Run())
	for _, p := range []string{"page.HTML", "image.svg", "text.txt", ".hidden.html"} {
		require.NoError(t, os.WriteFile(filepath.Join(root, p), []byte("sample"), 0600))
	}
	require.NoError(t, os.Mkdir(filepath.Join(root, "directory.html"), 0700))
	ss.RegisterLiveSession(context.Background(), &store.LiveSession{AgentName: "browser-agent", AgentType: "claude", WorkingDir: root, SessionID: "browser-1"})
	old := openFileInBrowser
	defer func() { openFileInBrowser = old }()
	calls := 0
	fail := false
	openFileInBrowser = func(p string) error {
		calls++
		require.Equal(t, filepath.Join(root, "page.HTML"), p)
		if fail {
			return errors.New("Could not open the file in your browser")
		}
		return nil
	}
	reset := func() {
		browserOpens.Lock()
		browserOpens.since = time.Time{}
		browserOpens.count = 0
		browserOpens.busy = false
		browserOpens.Unlock()
	}
	reset()
	t.Cleanup(reset)
	call := func(ref, kind, peer string, headers map[string]string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"filepath": ref, "session_id": "browser-1"})
		r := httptest.NewRequest("POST", "/api/sessions/live/browser-agent/open-in-browser", strings.NewReader(string(body)))
		r.RemoteAddr = peer
		ctx := context.WithValue(r.Context(), callerKindKey{}, kind)
		rc := chi.NewRouteContext()
		rc.URLParams.Add("name", "browser-agent")
		ctx = context.WithValue(ctx, chi.RouteCtxKey, rc)
		r = r.WithContext(ctx)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		h.OpenInBrowser(w, r)
		return w
	}
	for _, tc := range []struct {
		name, kind, peer string
		headers          map[string]string
	}{
		{"API key", callerAPIKey, "127.0.0.1:1234", nil}, {"Hub owner", callerHubOwner, "127.0.0.1:1234", nil}, {"Hub", callerHub, "127.0.0.1:1234", nil}, {"agent", callerAgentToken, "127.0.0.1:1234", nil},
		{"token header", callerDashCookie, "127.0.0.1:1234", map[string]string{store.SessionTokenHeader: "token"}},
		{"tunnel", callerDashCookie, "127.0.0.1:1234", map[string]string{tunnel.ViaHeader: "forged"}},
		{"proxy", callerDashCookie, "127.0.0.1:1234", map[string]string{"X-Forwarded-For": "127.0.0.1"}},
		{"remote", callerDashCookie, "192.0.2.1:1234", nil}, {"signed CLI", callerCLISigned, "127.0.0.1:1234", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, http.StatusForbidden, call("page.HTML", tc.kind, tc.peer, tc.headers).Code)
			require.Zero(t, calls)
		})
	}
	for _, ref := range []string{"text.txt", ".hidden.html", "directory.html", "missing.html", "../outside.html", `\\host\share\x.html`, "page.HTML%00", "page.HTML%0a"} {
		w := call(ref, callerDashCookie, "127.0.0.1:1234", nil)
		require.NotEqual(t, 200, w.Code, ref)
		require.NotContains(t, w.Body.String(), root)
		require.Zero(t, calls)
	}
	if err := os.Symlink(filepath.Join(root, "page.HTML"), filepath.Join(root, "link.html")); err == nil {
		require.NotEqual(t, 200, call("link.html", callerDashCookie, "127.0.0.1:1234", nil).Code)
		require.Zero(t, calls)
	}
	if err := os.Symlink(root, filepath.Join(root, "linked-dir")); err == nil {
		require.NotEqual(t, 200, call("linked-dir/page.HTML", callerDashCookie, "127.0.0.1:1234", nil).Code)
		require.Zero(t, calls)
	}
	w := call("page.HTML#L3", callerDashCookie, "127.0.0.1:1234", nil)
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Equal(t, 1, calls)
	fail = true
	w = call("page.HTML:3", callerDashCookie, "127.0.0.1:1234", nil)
	require.Equal(t, 400, w.Code)
	require.NotContains(t, w.Body.String(), root)
	browserOpens.Lock()
	browserOpens.busy = true
	browserOpens.Unlock()
	w = call("page.HTML", callerDashCookie, "127.0.0.1:1234", nil)
	require.Equal(t, 429, w.Code)
	require.Equal(t, "action", w.Header().Get("X-Coral-Limit"))
	browserOpens.Lock()
	browserOpens.busy = false
	browserOpens.count = 5
	browserOpens.Unlock()
	require.Equal(t, 429, call("page.HTML", callerDashCookie, "127.0.0.1:1234", nil).Code)
	require.Equal(t, 2, calls)
}
