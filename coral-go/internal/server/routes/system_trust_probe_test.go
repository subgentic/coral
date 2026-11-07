package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/httputil"
)

func TestProjectTrustProbeNamesAndLinks(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Code", "project")
	require.NoError(t, os.MkdirAll(dir, 0700))
	check := func() map[string]any { return probeProjectTrust(dir, home) }
	require.Equal(t, true, check()["checked"])
	for _, name := range []string{".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".codex/config.toml"} {
		full := filepath.Join(dir, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(full), 0700))
		require.NoError(t, os.WriteFile(full, []byte("PRIVATE CONTENT NEVER RETURNED"), 0600))
		out := check()
		require.Equal(t, true, out["checked"])
		require.True(t, out["files"].(map[string]bool)[name])
		encoded, _ := json.Marshal(out)
		require.NotContains(t, string(encoded), "PRIVATE")
	}
	require.Len(t, check()["files"], 4)
	full := filepath.Join(dir, ".mcp.json")
	require.NoError(t, os.Remove(full))
	if err := os.Symlink(filepath.Join(dir, ".claude", "settings.json"), full); err == nil {
		require.Equal(t, map[string]any{"checked": false}, check())
	}
	require.Equal(t, false, probeProjectTrust(home, home)["checked"])
	require.Equal(t, false, probeProjectTrust(filepath.Join(home, "Code"), home)["checked"])
	require.Equal(t, false, probeProjectTrust("relative", home)["checked"])
	require.Equal(t, false, probeProjectTrust(dir+"\n", home)["checked"])
	link := filepath.Join(home, "Code", "linked")
	if err := os.Symlink(dir, link); err == nil {
		require.Equal(t, false, probeProjectTrust(link, home)["checked"])
		require.Equal(t, false, probeProjectTrust(link+string(filepath.Separator), home)["checked"])
	}
}

func TestProjectTrustProbeCallerAndRate(t *testing.T) {
	h := &SystemHandler{}
	call := func(kind string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/filesystem/trust-probe?path="+url.QueryEscape(t.TempDir()), nil)
		if kind != "" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		}
		rec := httptest.NewRecorder()
		h.TrustFolderProbe(rec, req)
		return rec
	}
	require.Equal(t, 403, call("").Code, "no script/CLI caller")
	require.Equal(t, 200, call(callerDashNoCookie).Code)
	limited := call(callerDashNoCookie)
	require.Equal(t, 429, limited.Code)
	assert.Equal(t, "action", limited.Header().Get(httputil.ActionLimitHeader), "a marked per-action limit: the overload watch must not read it as a busy server (#3434)")
	assert.Equal(t, "1", limited.Header().Get("Retry-After"))
	assert.JSONEq(t, `{"checked":false}`, limited.Body.String(), "the dialog's body keeps its shape")
	h.trustProbeAt = time.Now().Add(-time.Second)
	require.Equal(t, 200, call(callerDashCookie).Code)
}
