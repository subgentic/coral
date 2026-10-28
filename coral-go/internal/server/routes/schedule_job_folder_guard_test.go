package routes

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10534 (Security Reviewer Windows on #10276, SHOULD 4): a job that runs without a worktree works in the folder itself, an agent with the person's permissions: it may not be the home folder or the
// root of the disk, with the refusal and the words init-repo gives; the same on create and on update, and a project folder is still fine.
func TestAJobWithoutAWorktreeMayNotRunInTheHomeFolderOrTheDiskRoot(t *testing.T) {
	srv, _ := scheduleTestServer(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	project := t.TempDir()
	root := string(filepath.Separator)
	if runtime.GOOS == "windows" {
		root = filepath.VolumeName(home) + `\`
	}
	job := func(repo string) map[string]any {
		return map[string]any{"name": "nightly", "cron_expr": "0 9 * * *", "timezone": "UTC", "repo_path": repo, "prompt": "do it", "no_worktree": 1}
	}
	for name, dir := range map[string]string{"the home folder": home, "the root of the disk": root} {
		code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job(dir))
		assert.Equal(t, http.StatusBadRequest, code, name+": refused when created")
		assert.Equal(t, homeOrRootError, body["error"], name+": init-repo's words")
	}
	// the same words as init-repo's for the home folder
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": home})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Equal(t, homeOrRootError, body["error"])

	// a project folder is fine, and an update to the home folder or the root is refused too
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job(project))
	require.Equal(t, http.StatusOK, code, "%v", body)
	id := strconv.Itoa(int(body["id"].(float64)))
	for name, dir := range map[string]string{"the home folder": home, "the root of the disk": root} {
		code, body = sendJSON(t, http.MethodPut, srv.URL+"/api/scheduled/jobs/"+id, map[string]any{"repo_path": dir})
		assert.Equal(t, http.StatusBadRequest, code, name+": refused when changed")
		assert.Equal(t, homeOrRootError, body["error"])
	}
	// a worktree job in the home folder is refused as it always was (not a repository), by its own words
	wt := job(home)
	delete(wt, "no_worktree")
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", wt)
	assert.Equal(t, http.StatusBadRequest, code)
	assert.NotEmpty(t, body["error"])
}

// #10534 (LOW 5): the first commit init-repo makes is Coral's own placeholder: a person whose git signs every commit (commit.gpgsign, a signing program that asks or is missing) still gets it.
func TestTheFirstCommitOfInitRepoIsNeverSigned(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	global := filepath.Join(t.TempDir(), "gitconfig")
	require.NoError(t, os.WriteFile(global, []byte("[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent-signing-program\n[user]\n\tname = Someone\n\temail = someone@example.invalid\n"), 0o600))
	t.Setenv("GIT_CONFIG_GLOBAL", global)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	dir := t.TempDir()
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": dir})
	require.Equal(t, http.StatusOK, code, "%v", body)
	out, err := exec.Command("git", "-C", dir, "rev-list", "--count", "HEAD").Output()
	require.NoError(t, err)
	assert.Equal(t, "1", strings.TrimSpace(string(out)), "the first commit was made with signing on")
}
