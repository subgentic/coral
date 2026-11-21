package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/pkg/tunnel"
)

func launchWhereServer(t *testing.T) (*httptest.Server, *config.Config) {
	t.Helper()
	cfg := config.Load(t.TempDir())
	sys := &SystemHandler{cfg: cfg}
	r := chi.NewRouter()
	r.Get("/api/launch/where", sys.LaunchWhere)
	r.Get("/api/launch/check", sys.LaunchCheck)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, cfg
}

func launchGet(t *testing.T, srv *httptest.Server, path string, q url.Values) map[string]any {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path+"?"+q.Encode(), nil)
	req.Header.Set("Origin", srv.URL) // the dashboard's own page: the relaxed folder bounds, as the folder browser gives it
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	return out
}

func checkOf(out map[string]any, id string) map[string]any {
	for _, c := range out["checks"].([]any) {
		if m := c.(map[string]any); m["id"] == id {
			return m
		}
	}
	return nil
}

// #20388: the where step reads the repository as it is: branch, clean/dirty, other branches, the worktrees; nothing is created.
func TestLaunchWhereReadsABranchItsStateAndItsWorktrees(t *testing.T) {
	srv, _ := launchWhereServer(t)
	repo, git := repoOn(t, "trunk", true)
	git("branch", "feature")
	wt := filepath.Join(t.TempDir(), "side")
	git("worktree", "add", "-b", "other", wt)

	out := launchGet(t, srv, "/api/launch/where", url.Values{"path": {repo}})
	assert.Equal(t, true, out["is_repo"])
	assert.Equal(t, "trunk", out["branch"])
	assert.Equal(t, true, out["clean"])
	assert.ElementsMatch(t, []any{"trunk", "feature", "other"}, out["branches"])
	wts := out["worktrees"].([]any)
	require.Len(t, wts, 2)
	assert.Equal(t, true, wts[0].(map[string]any)["main"])
	assert.Equal(t, "other", wts[1].(map[string]any)["branch"])

	require.NoError(t, os.WriteFile(filepath.Join(repo, "new.txt"), []byte("x"), 0o644))
	out = launchGet(t, srv, "/api/launch/where", url.Values{"path": {repo}})
	assert.Equal(t, false, out["clean"])
	assert.EqualValues(t, 1, out["changed"])

	out = launchGet(t, srv, "/api/launch/where", url.Values{"path": {t.TempDir()}})
	assert.Equal(t, false, out["is_repo"])
	assert.Contains(t, out["reason"], "not a git repository")
	out = launchGet(t, srv, "/api/launch/where", url.Values{"path": {filepath.Join(repo, "nosuch")}})
	assert.Contains(t, out["reason"], "does not exist")
}

func TestParseStatusBranchReadsAheadAndBehind(t *testing.T) {
	up, a, b := parseStatusBranch("## main...origin/main [ahead 2, behind 3]")
	assert.Equal(t, "origin/main", up)
	assert.Equal(t, 2, a)
	assert.Equal(t, 3, b)
	up, a, b = parseStatusBranch("## main")
	assert.Equal(t, "", up)
	assert.Zero(t, a+b)
}

// #20388: each failure of the setup check has a plain reason and a fix; a good setup passes.
func TestLaunchCheckSaysWhatIsWrongBeforeTheLaunch(t *testing.T) {
	srv, cfg := launchWhereServer(t)
	repo, git := repoOn(t, "trunk", true)
	wt := filepath.Join(t.TempDir(), "side")
	git("worktree", "add", "-b", "other", wt)

	ok := launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "branch": {"trunk"}})
	assert.Equal(t, true, ok["ok"], ok)

	out := launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "branch": {"nosuch"}})
	assert.Equal(t, false, out["ok"])
	c := checkOf(out, "branch")
	require.NotNil(t, c)
	assert.Contains(t, c["reason"], "no branch named nosuch")
	assert.NotEmpty(t, c["fix"])

	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "branch": {"other"}})
	c = checkOf(out, "branch_free")
	require.NotNil(t, c)
	assert.Equal(t, false, c["ok"], "a branch checked out in another worktree is not free")
	assert.Contains(t, c["reason"], "already checked out")

	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {t.TempDir()}, "branch": {"trunk"}})
	assert.Contains(t, checkOf(out, "repo")["reason"], "not a git repository")

	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {filepath.Join(repo, "gone")}})
	assert.Contains(t, checkOf(out, "folder")["reason"], "does not exist")

	// a new worktree: a free name passes, a taken or bad name does not, a missing base does not
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"fresh"}, "base": {"trunk"}})
	assert.Equal(t, true, out["ok"], out)
	require.NoError(t, os.MkdirAll(filepath.Join(cfg.CoralDir(), "worktrees", "taken"), 0o755))
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"taken"}, "base": {"trunk"}})
	assert.Contains(t, checkOf(out, "worktree_free")["reason"], "already in the worktrees folder")
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"../evil"}, "base": {"trunk"}})
	assert.Contains(t, checkOf(out, "worktree_free")["reason"], "cannot be a worktree's folder")
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"fresh"}, "base": {"nosuch"}})
	assert.Contains(t, checkOf(out, "base")["reason"], "no branch named nosuch")
}

// A caller that is not this computer's own dashboard (the Hub, a proxy) is held to the project folders, as the folder browser holds it: a folder outside them is answered as one that is not there.
func TestLaunchWhereHoldsABoundedCallerToTheProjectFolders(t *testing.T) {
	srv, _ := launchWhereServer(t)
	repo, _ := repoOn(t, "trunk", true)
	t.Setenv("CORAL_PROJECT_ROOTS", "")
	for _, route := range []string{"/api/launch/where", "/api/launch/check"} {
		req, _ := http.NewRequest("GET", srv.URL+route+"?path="+url.QueryEscape(repo), nil)
		req.Header.Set(tunnel.ViaHeader, "1")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		resp.Body.Close()
		assert.NotEqual(t, true, out["is_repo"], route)
		assert.NotContains(t, out, "branches", route)
		assert.Empty(t, out["recent"], route)
	}
}
