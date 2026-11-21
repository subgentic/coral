package routes

import (
	"encoding/json"
	"io"
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
	"github.com/subgentic/coral/internal/consoletest"
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
	srv, _ := launchWhereServer(t)
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
	require.NoError(t, os.MkdirAll(filepath.Join(defaultWorktreeDir(realOf(t, repo)), "taken"), 0o755))
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"taken"}, "base": {"trunk"}})
	assert.Contains(t, checkOf(out, "worktree_free")["reason"], "folder already exists")
	out = launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "new_worktree": {"../evil"}, "base": {"trunk"}})
	assert.Contains(t, checkOf(out, "worktree_free")["reason"], "cannot be a branch and a folder")
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

// Security's MUST on #20388 slice A: through Coral Hub the answers of both reads carry no home path anywhere: a branch checked out in a worktree under the home says so without its path in the sentence, the path is in
// a path field shown as "~/...", the lists (recent, worktrees) too, and the connector's classifier lets exactly these requests through.
func TestLaunchReadsThroughTheHubCarryNoHomePath(t *testing.T) {
	e := newBoundsEnv(t)
	repo := filepath.Join(e.home, "projects", "app")
	wtDir := filepath.Join(e.home, "projects", "app-side")
	for _, args := range [][]string{{"init", "-q", "-b", "trunk", repo}, {"-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"}, {"-C", repo, "worktree", "add", "-b", "other", wtDir}} {
		out, err := consoletest.HiddenCommand("git", args...).CombinedOutput()
		require.NoError(t, err, string(out))
	}
	r := chi.NewRouter()
	r.Use(HubPaths)
	sys := &SystemHandler{cfg: config.Load(t.TempDir())}
	r.Get("/api/launch/where", sys.LaunchWhere)
	r.Get("/api/launch/check", sys.LaunchCheck)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	get := func(route string, q url.Values) string {
		require.Equal(t, tunnel.TierLaunch, tunnel.Classify("GET", route, q.Encode()), "the connector lets %s %v through", route, q)
		req, _ := http.NewRequest("GET", srv.URL+route+"?"+q.Encode(), nil)
		req.Header.Set(tunnel.ViaHeader, "1")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	for name, body := range map[string]string{
		"check branch free": get("/api/launch/check", url.Values{"path": {"~/projects/app"}, "branch": {"other"}}),
		"check worktree":    get("/api/launch/check", url.Values{"path": {"~/projects/app"}, "new_worktree": {"x"}, "base": {"trunk"}}),
		"where":             get("/api/launch/where", url.Values{"path": {"~/projects/app"}}),
	} {
		assert.NotContains(t, body, e.home, name+": the home path never reaches the Hub: %s", body)
	}
	body := get("/api/launch/check", url.Values{"path": {"~/projects/app"}, "branch": {"other"}})
	assert.Contains(t, body, "already checked out in another worktree of this repository")
	assert.Contains(t, body, `"path":"~/projects/app-side"`)
	assert.Contains(t, get("/api/launch/where", url.Values{"path": {"~/projects/app"}}), "~/projects/app-side")
}

// #20388: the check says whether Claude already trusts the folder (a read of its settings), and a new worktree's folder is the one typed or <repo>-worktrees/<name>; the where answer names that folder and the setting.
func TestLaunchCheckReadsFolderTrustAndTheNewWorktreeFolder(t *testing.T) {
	srv, _ := launchWhereServer(t)
	repo, _ := repoOn(t, "trunk", true)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	where := launchGet(t, srv, "/api/launch/where", url.Values{"path": {repo}})
	assert.Equal(t, defaultWorktreeDir(realOf(t, repo)), where["worktree_dir"])
	assert.Equal(t, false, where["worktree_launch"], "off until the setting is on")

	ask := func(extra url.Values) map[string]any {
		q := url.Values{"path": {repo}, "type": {"claude"}}
		for k, v := range extra {
			q[k] = v
		}
		return launchGet(t, srv, "/api/launch/check", q)
	}
	c := checkOf(ask(nil), "trusted")
	require.NotNil(t, c)
	assert.Equal(t, true, c["ok"])
	assert.Contains(t, c["reason"], "not checked", "no settings file: unknown, never trusted")

	require.NoError(t, os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"projects":{}}`), 0o600))
	c = checkOf(ask(nil), "trusted")
	assert.Contains(t, c["reason"], "will ask")
	require.NoError(t, os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{"projects":{"`+realOf(t, repo)+`":{"hasTrustDialogAccepted":true}}}`), 0o600))
	c = checkOf(ask(nil), "trusted")
	assert.Equal(t, true, c["ok"])
	assert.Empty(t, c["reason"])
	assert.Contains(t, checkOf(launchGet(t, srv, "/api/launch/check", url.Values{"path": {repo}, "type": {"pi"}}), "trusted")["reason"], "not checked")

	free := checkOf(ask(url.Values{"new_worktree": {"fix-login"}}), "worktree_free")
	assert.Equal(t, true, free["ok"])
	assert.Equal(t, filepath.Join(defaultWorktreeDir(realOf(t, repo)), "fix-login"), free["path"])
	mine := filepath.Join(t.TempDir(), "mine")
	assert.Equal(t, mine, checkOf(ask(url.Values{"new_worktree": {"x"}, "worktree_path": {mine}}), "worktree_free")["path"])
	bad := checkOf(ask(url.Values{"new_worktree": {"x"}, "worktree_path": {"relative"}}), "worktree_free")
	assert.Equal(t, false, bad["ok"])
	assert.NotContains(t, bad["reason"], home, "no path in a sentence")
}

func realOf(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	require.NoError(t, err)
	return r
}
