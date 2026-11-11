package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
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

// Each case keeps all the other inputs valid: the refusal is about the named
// policy category rather than a second bad file, missing path or invalid home.
func TestProjectTrustProbeLeadingConfigDirectoryLink(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Code", "project")
	target := filepath.Join(dir, "project-settings")
	require.NoError(t, os.MkdirAll(target, 0700))
	require.NoError(t, os.WriteFile(filepath.Join(target, "settings.json"), []byte("not read"), 0600))
	if err := os.Symlink("project-settings", filepath.Join(dir, ".claude")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	require.Equal(t, map[string]any{"checked": false}, probeProjectTrust(dir, home), "a leading config-directory link is unchecked even when it points inside the eligible project")
}

func TestProjectTrustProbeNonRegularConfig(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "Code", "project")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".mcp.json"), 0700))
	require.Equal(t, map[string]any{"checked": false}, probeProjectTrust(dir, home), "an existing config name that is a directory is not a regular file")
}

func TestProjectTrustProbeRelativePathInEligibleWorkingDirectory(t *testing.T) {
	home := t.TempDir()
	parent := filepath.Join(home, "Code")
	dir := filepath.Join(parent, "project")
	require.NoError(t, os.MkdirAll(dir, 0700))
	t.Chdir(parent)
	require.Equal(t, true, probeProjectTrust(dir, home)["checked"], "positive control: this absolute project is eligible")
	require.Equal(t, map[string]any{"checked": false}, probeProjectTrust("project", home), "an otherwise eligible project must not accept a relative request or silently normalize it")
}

// #15091 (Beta Tester's walk 2): a folder Coral can never trust showed the Trust switch, and only the launch said no, in a red toast. The probe says so up front: a refused folder answers
// "refused" with the plain sentence (no path), an ordinary one has no such key.
func TestProjectTrustProbeSaysWhyAFolderIsRefused(t *testing.T) {
	home := t.TempDir()
	proj := filepath.Join(home, "Code", "project")
	hidden := filepath.Join(home, ".config", "x")
	for _, d := range []string{proj, hidden} {
		require.NoError(t, os.MkdirAll(d, 0700))
	}
	require.NotContains(t, probeProjectTrust(proj, home), "refused", "an ordinary project folder is not refused")
	for name, dir := range map[string]string{"home itself": home, "a direct child of home": filepath.Join(home, "Code"), "a hidden folder": hidden} {
		out := probeProjectTrust(dir, home)
		require.Equal(t, false, out["checked"], name)
		reason, _ := out["refused"].(string)
		require.NotEmpty(t, reason, "%s: the answer says why", name)
		require.NotContains(t, reason, home, "%s: the sentence names no path", name)
	}
	if shared := "/private/tmp"; runtime.GOOS == "darwin" {
		if fi, err := os.Lstat(shared); err == nil && fi.IsDir() {
			sub, err := os.MkdirTemp(shared, "trustprobe")
			require.NoError(t, err)
			defer os.RemoveAll(sub)
			reason, _ := probeProjectTrust(sub, home)["refused"].(string)
			require.Contains(t, reason, "shared", "a folder under the temp directory is refused as shared")
		}
	}
}
