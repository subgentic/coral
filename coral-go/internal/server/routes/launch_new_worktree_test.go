package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/store"
)

func placeOn(t *testing.T, h *SessionsHandler, dir string, nw *launchNewWorktree, checkout string, confirm bool) (string, bool, int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "http://127.0.0.1:8420/api/sessions/launch", nil)
	r.Header.Set("Origin", "http://127.0.0.1:8420") // the dashboard's own page: the relaxed folder bounds
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.RemoteAddr = "127.0.0.1:5555"
	placed, ok := h.placeLaunchOnBranch(w, r, dir, nw, checkout, confirm)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return placed, ok, w.Code, out
}

// #20388: a launch can make a new git worktree first (for one agent or one terminal, as a team's can), in <repo>-worktrees/<name> or the folder the person typed; the setting that gates worktree launches still applies.
func TestAnAgentLaunchMakesANewWorktreeNextToTheRepository(t *testing.T) {
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	repo := worktreeRepo(t)
	nw := &launchNewWorktree{Name: "fix-login"}

	_, ok, code, out := placeOn(t, rig.h, repo, nw, "", false)
	assert.False(t, ok)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Contains(t, out["error"], "turned off", "the experimental switch (#12746) still gates it")
	assert.NoDirExists(t, defaultWorktreeDir(realOf(t, repo))+"/fix-login")

	require.NoError(t, rig.ss.SetSetting(ctx, "launch_in_worktree", "true"))
	placed, ok, _, out := placeOn(t, rig.h, repo, nw, "", false)
	require.True(t, ok, "%v", out)
	assert.Equal(t, filepath.Join(defaultWorktreeDir(realOf(t, repo)), "fix-login"), placed)
	assert.Equal(t, "fix-login", strings.TrimSpace(gitOut(t, placed, "rev-parse", "--abbrev-ref", "HEAD")), "on its own branch")
	assert.Equal(t, "main", strings.TrimSpace(gitOut(t, repo, "rev-parse", "--abbrev-ref", "HEAD")), "the folder is untouched")

	_, ok, code, out = placeOn(t, rig.h, repo, nw, "", false) // a second launch on the same name does not reuse the first one's files
	assert.False(t, ok)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, "that folder already exists", out["error"])

	// the folder the person typed
	mine := filepath.Join(t.TempDir(), "mine")
	placed, ok, _, out = placeOn(t, rig.h, repo, &launchNewWorktree{Name: "docs-pass", Path: mine}, "", false)
	require.True(t, ok, "%v", out)
	assert.Equal(t, mine, placed)
}

func TestANewWorktreeRefusesBadNamesAndFolders(t *testing.T) {
	rig := setupAgyTestRig(t)
	require.NoError(t, rig.ss.SetSetting(context.Background(), "launch_in_worktree", "true"))
	repo := worktreeRepo(t)
	for _, c := range []launchNewWorktree{
		{Name: "../escape"}, {Name: "-x"}, {Name: "a b"}, {Name: ".."}, {Name: strings.Repeat("a", 80)},
		{Name: "ok", Path: "relative/dir"}, {Name: "ok", Path: t.TempDir() + "/../up"}, {Name: "ok", Path: filepath.Join(t.TempDir(), "missing-parent", "wt")},
		{Name: "ok", Base: "--upload-pack=touch /tmp/pwned"}, {Name: "ok", Base: "no-such-branch"},
	} {
		c := c
		_, ok, code, out := placeOn(t, rig.h, repo, &c, "", false)
		assert.False(t, ok, "%+v", c)
		assert.Equal(t, http.StatusBadRequest, code, "%+v: %v", c, out)
	}
	assert.NoDirExists(t, defaultWorktreeDir(realOf(t, repo)), "a refused launch made nothing")
	_, ok, code, _ := placeOn(t, rig.h, t.TempDir(), &launchNewWorktree{Name: "ok"}, "", false)
	assert.False(t, ok, "a folder that is not a repository has nothing to branch")
	assert.Equal(t, http.StatusBadRequest, code)
}

func TestSwitchingAFolderToAnotherBranchAsksFirstWhenItHasChanges(t *testing.T) {
	rig := setupAgyTestRig(t)
	repo, git := repoOn(t, "main", true)
	git("branch", "other")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "wip.txt"), []byte("x"), 0o600))

	_, ok, code, out := placeOn(t, rig.h, repo, nil, "other", false)
	assert.False(t, ok)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, true, out["confirm_checkout"], "the page asks the person")
	assert.Equal(t, "main", strings.TrimSpace(git("rev-parse", "--abbrev-ref", "HEAD")), "nothing moved before the answer")

	placed, ok, _, out := placeOn(t, rig.h, repo, nil, "other", true)
	require.True(t, ok, "%v", out)
	assert.Equal(t, repo, placed)
	assert.Equal(t, "other", strings.TrimSpace(git("rev-parse", "--abbrev-ref", "HEAD")))

	for _, b := range []string{"no-such", "--orphan", "main..other"} {
		_, ok, code, _ := placeOn(t, rig.h, repo, nil, b, true)
		assert.False(t, ok, b)
		assert.Equal(t, http.StatusBadRequest, code, b)
	}
	// a branch checked out in another worktree cannot be switched to here
	git("worktree", "add", "-q", "-b", "elsewhere", filepath.Join(t.TempDir(), "wt"))
	_, ok, code, out = placeOn(t, rig.h, repo, nil, "elsewhere", true)
	assert.False(t, ok)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Contains(t, out["error"], "already checked out in another worktree")
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := consoletest.HiddenCommand("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	require.NoError(t, err, string(out))
	return string(out)
}

// Security r4: an agent running in the folder is told before its branch changes under it, and a repository's own post-checkout hook never runs on the launch's checkout.
func TestSwitchingABranchUnderARunningAgentAsksFirstAndRunsNoRepositoryHook(t *testing.T) {
	rig := setupAgyTestRig(t)
	repo, git := repoOn(t, "main", true)
	git("branch", "other")
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := filepath.Join(repo, ".git", "hooks", "post-checkout")
	require.NoError(t, os.WriteFile(hook, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0o755))
	require.NoError(t, rig.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "s-live", AgentType: "claude", AgentName: "Dev One", WorkingDir: repo}))

	_, ok, code, out := placeOn(t, rig.h, repo, nil, "other", false)
	assert.False(t, ok)
	assert.Equal(t, http.StatusConflict, code)
	assert.Equal(t, true, out["confirm_checkout"])
	assert.Contains(t, out["error"], "Dev One is running in this folder")
	assert.Equal(t, "main", strings.TrimSpace(git("rev-parse", "--abbrev-ref", "HEAD")), "nothing moved before the answer")

	_, ok, _, out = placeOn(t, rig.h, repo, nil, "other", true)
	require.True(t, ok, "%v", out)
	assert.Equal(t, "other", strings.TrimSpace(git("rev-parse", "--abbrev-ref", "HEAD")))
	_, err := os.Stat(marker)
	assert.True(t, os.IsNotExist(err), "the post-checkout hook must not run on a launch checkout")
}
