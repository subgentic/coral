package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

func uncommittedServer(t *testing.T) (string, *store.TeamStore) {
	t.Helper()
	_, handler, _, _, ts := archiveTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/teams/detail/{name}/uncommitted", handler.TeamUncommitted)
	r.Post("/api/teams/detail/{name}/commit", handler.TeamCommit)
	hs := httptest.NewServer(r)
	t.Cleanup(hs.Close)
	return hs.URL, ts
}

func uncGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := consoletest.HiddenCommand("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

// teamWithWork is a team whose folder is a repository with one commit, then work left in it: a changed file, a new file and a .env.
func teamWithWork(t *testing.T, ts *store.TeamStore) (name, dir string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir = homeReal(t, t.TempDir())
	uncGit(t, dir, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tip.js"), []byte("v1\n"), 0o644))
	uncGit(t, dir, "add", "tip.js")
	uncGit(t, dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tip.js"), []byte("v2\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "tip.test.js"), []byte("test\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".env"), []byte("KEY=1\n"), 0o644))
	_, err := ts.CreateTeam(context.Background(), &store.Team{Name: "walk55", ConfigJSON: "{}", WorkingDir: dir})
	require.NoError(t, err)
	return "walk55", dir
}

// #17203: the team's folder with work not committed is listed, with the counts, and a clean or plain folder is not.
func TestTeamUncommittedListsTheFolderWithWorkLeftInIt(t *testing.T) {
	base, ts := uncommittedServer(t)
	name, dir := teamWithWork(t, ts)
	code, body := sendJSON(t, http.MethodGet, base+"/api/teams/detail/"+name+"/uncommitted", nil)
	require.Equal(t, http.StatusOK, code, "%v", body)
	repos := body["repos"].([]any)
	require.Len(t, repos, 1, "%v", body)
	repo := repos[0].(map[string]any)
	assert.Equal(t, dir, repo["folder"])
	assert.EqualValues(t, 1, repo["changed"], "tip.js is changed")
	assert.EqualValues(t, 2, repo["new"], "tip.test.js and .env are new")
	assert.Equal(t, []any{".env"}, repo["secret_like"], "a file that looks like a secret is named")

	uncGit(t, dir, "add", "-A")
	uncGit(t, dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "all")
	code, body = sendJSON(t, http.MethodGet, base+"/api/teams/detail/"+name+"/uncommitted", nil)
	require.Equal(t, http.StatusOK, code)
	assert.Empty(t, body["repos"], "a clean folder says nothing")
	code, _ = sendJSON(t, http.MethodGet, base+"/api/teams/detail/nobody/uncommitted", nil)
	assert.Equal(t, http.StatusNotFound, code)
}

// #17203: Commit makes one local commit of the listed files, leaves a secret-looking file out unless the person includes it, and never runs the repository's hooks.
func TestTeamCommitMakesOneLocalCommitWithoutSecretsOrHooks(t *testing.T) {
	base, ts := uncommittedServer(t)
	name, dir := teamWithWork(t, ts)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".git", "hooks", "pre-commit"), []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755))
	url := base + "/api/teams/detail/" + name + "/commit"

	code, _ := sendJSON(t, http.MethodPost, url, map[string]any{"folder": dir, "message": "  "})
	assert.Equal(t, http.StatusBadRequest, code, "a commit needs a message")
	code, _ = sendJSON(t, http.MethodPost, url, map[string]any{"folder": t.TempDir(), "message": "x"})
	assert.Equal(t, http.StatusBadRequest, code, "only a folder of the team")

	code, body := sendJSON(t, http.MethodPost, url, map[string]any{"folder": dir, "message": "Fix the tip rounding"})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.EqualValues(t, 2, body["files"])
	assert.Equal(t, "Fix the tip rounding", uncGit(t, dir, "log", "-1", "--format=%s"))
	assert.Equal(t, "2", uncGit(t, dir, "rev-list", "--count", "HEAD"), "one new commit")
	assert.Equal(t, "tip.js\ntip.test.js", uncGit(t, dir, "show", "--name-only", "--format=", "HEAD"), "the .env is left out")
	assert.Contains(t, uncGit(t, dir, "status", "--porcelain"), "?? .env", "and still there, untracked")
	_, err := os.Stat(marker)
	assert.True(t, os.IsNotExist(err), "the repository's hooks are not run")

	code, body = sendJSON(t, http.MethodPost, url, map[string]any{"folder": dir, "message": "again"})
	assert.Equal(t, http.StatusConflict, code, "only the .env is left, and it is not included")
	assert.Equal(t, "nothing_to_commit", body["code"])
	code, body = sendJSON(t, http.MethodPost, url, map[string]any{"folder": dir, "message": "the env too", "include_secret_like": true})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, ".env", uncGit(t, dir, "show", "--name-only", "--format=", "HEAD"), "included when the person says so")
}

// #17203: a commit that fails shows git's words and puts back only what Commit staged: a file the person had staged stays staged.
func TestTeamCommitFailureLeavesTheIndexAsItWas(t *testing.T) {
	base, ts := uncommittedServer(t)
	name, dir := teamWithWork(t, ts)
	uncGit(t, dir, "add", "tip.js") // the person had staged this one
	require.NoError(t, os.WriteFile(filepath.Join(dir, ".git", "index.lock"), nil, 0o644))
	code, body := sendJSON(t, http.MethodPost, base+"/api/teams/detail/"+name+"/commit", map[string]any{"folder": dir, "message": "x"})
	assert.Equal(t, http.StatusConflict, code, "%v", body)
	assert.Equal(t, "commit_failed", body["code"])
	assert.Contains(t, body["output"], "index.lock", "git's own words are shown")
	require.NoError(t, os.Remove(filepath.Join(dir, ".git", "index.lock")))
	assert.Equal(t, "tip.js", uncGit(t, dir, "diff", "--cached", "--name-only"), "what the person staged stays staged, nothing else was")
	assert.Equal(t, "1", uncGit(t, dir, "rev-list", "--count", "HEAD"), "no commit was made")
}

// #17203 (Security MUST 1): a secret-looking file the person had already staged, and Commit leaves out, is not in the commit: only the listed paths are committed, and it stays staged.
func TestTeamCommitDoesNotCommitAStagedSecretItLeftOut(t *testing.T) {
	base, ts := uncommittedServer(t)
	name, dir := teamWithWork(t, ts)
	uncGit(t, dir, "add", ".env") // already staged by the person (or an agent)
	code, body := sendJSON(t, http.MethodPost, base+"/api/teams/detail/"+name+"/commit", map[string]any{"folder": dir, "message": "work"})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, "tip.js\ntip.test.js", uncGit(t, dir, "show", "--name-only", "--format=", "HEAD"), "the staged .env is not in the commit")
	assert.Equal(t, ".env", uncGit(t, dir, "diff", "--cached", "--name-only"), "and it is still staged, as it was")
}

// #17203 (Security MUST 2): file names are literal pathspecs. A new file named "*" must not stage, and so commit, every file (the left-out .env with them).
func TestTeamCommitTakesFileNamesLiterally(t *testing.T) {
	base, ts := uncommittedServer(t)
	name, dir := teamWithWork(t, ts)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "*"), []byte("star\n"), 0o644))
	code, body := sendJSON(t, http.MethodPost, base+"/api/teams/detail/"+name+"/commit", map[string]any{"folder": dir, "message": "work"})
	require.Equal(t, http.StatusOK, code, "%v", body)
	committed := uncGit(t, dir, "show", "--name-only", "--format=", "HEAD")
	assert.NotContains(t, committed, ".env", "a glob in a file name is not a pattern for the left-out secret")
	assert.Contains(t, committed, "tip.js")
	assert.Equal(t, 3, len(strings.Split(committed, "\n")), "the three listed files, nothing else: %q", committed)
	assert.Contains(t, uncGit(t, dir, "status", "--porcelain"), "?? .env")
}
