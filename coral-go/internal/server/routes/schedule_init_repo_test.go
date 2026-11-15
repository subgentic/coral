package routes

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

// #10276: a plain folder, or a repository with no commit, is made a repository a job can run in when the person agrees: git init when needed, then one empty first commit.
func TestInitJobRepoMakesAFolderAJobCanRunIn(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	commits := func(dir string) string {
		out, _ := consoletest.HiddenCommand("git", "-C", dir, "rev-list", "--count", "HEAD").Output()
		return strings.TrimSpace(string(out))
	}
	job := func(repo string) map[string]any {
		return map[string]any{"name": "nightly", "cron_expr": "0 9 * * *", "timezone": "UTC", "repo_path": repo, "prompt": "do it"}
	}

	plain := t.TempDir()
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job(plain))
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Contains(t, body["error"], "is not a git repository", "a plain folder is refused with the words the form offers a fix for")
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": plain})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, true, body["created"])
	assert.Equal(t, "1", commits(plain), "one empty first commit")
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": plain})
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, false, body["created"], "a second click adds nothing")
	assert.Equal(t, "1", commits(plain))
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job(plain))
	assert.Equal(t, http.StatusOK, code, "the job can now be saved: %v", body)

	empty := t.TempDir()
	require.NoError(t, consoletest.HiddenCommand("git", "init", "-q", empty).Run()) // a repository with no commit yet
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job(empty))
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Contains(t, body["error"], "has no commit yet")
	code, _ = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": empty})
	assert.Equal(t, http.StatusOK, code)
	assert.Equal(t, "1", commits(empty), "the commit is made in the repository that was there")

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": home})
	assert.Equal(t, http.StatusBadRequest, code, "the home folder is not made a repository")
	assert.Contains(t, body["error"], "project folder")
	code, _ = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": plain + "/missing"})
	assert.Equal(t, http.StatusBadRequest, code)
	code, _ = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{})
	assert.Equal(t, http.StatusBadRequest, code)
}

// #10276: a job can run without a worktree: its runs work in the folder itself, which need not be a git repository. The choice is saved with the job, and a folder and a mode that do not go together are
// refused when either changes.
func TestJobRunWithoutAWorktreeNeedsOnlyAFolder(t *testing.T) {
	srv, _ := scheduleTestServer(t)
	plain := t.TempDir()
	job := map[string]any{"name": "nightly", "cron_expr": "0 9 * * *", "timezone": "UTC", "repo_path": plain, "prompt": "do it"}

	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job)
	assert.Equal(t, http.StatusBadRequest, code, "with a worktree, a plain folder is refused")
	assert.Contains(t, body["error"], "is not a git repository")

	job["no_worktree"] = 1
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job)
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.EqualValues(t, 1, body["no_worktree"], "the choice is saved with the job")
	id := strconv.Itoa(int(body["id"].(float64)))

	code, body = sendJSON(t, http.MethodPut, srv.URL+"/api/scheduled/jobs/"+id, map[string]any{"name": "renamed"})
	assert.Equal(t, http.StatusOK, code, "an edit that leaves the folder and the mode alone is not checked again: %v", body)
	assert.EqualValues(t, 1, body["no_worktree"])
	code, body = sendJSON(t, http.MethodPut, srv.URL+"/api/scheduled/jobs/"+id, map[string]any{"no_worktree": 0})
	assert.Equal(t, http.StatusBadRequest, code, "back to a worktree, the plain folder is refused")
	assert.Contains(t, body["error"], "is not a git repository")
	code, _ = sendJSON(t, http.MethodPut, srv.URL+"/api/scheduled/jobs/"+id, map[string]any{"repo_path": plain + "/missing"})
	assert.Equal(t, http.StatusBadRequest, code, "a folder that is not there is refused in either mode")
	code, _ = sendJSON(t, http.MethodPut, srv.URL+"/api/scheduled/jobs/"+id, map[string]any{"no_worktree": 7})
	assert.Equal(t, http.StatusBadRequest, code, "only 0 or 1")

	repo := gitRepo(t)
	delete(job, "no_worktree")
	job["repo_path"] = repo
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs", job)
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.EqualValues(t, 0, body["no_worktree"], "a job that says nothing keeps its worktree")
}

// #17150: the first commit was empty, so a job's worktree (made from it) had none of the folder's files, and the dialog said "Nothing in the folder is changed". With include_files the first commit holds
// the files that are in the folder now; without it the commit stays empty, as before.
func TestInitJobRepoCanIncludeTheFoldersFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	tracked := func(dir string) string {
		out, _ := consoletest.HiddenCommand("git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD").Output()
		return strings.TrimSpace(string(out))
	}
	mk := func() string {
		dir := t.TempDir()
		require.NoError(t, os.WriteFile(filepath.Join(dir, "index.html"), []byte("<p>hi</p>"), 0o644))
		return dir
	}

	empty := mk()
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": empty})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, "", tracked(empty), "without the choice the first commit is empty")

	full := mk()
	code, body = sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": full, "include_files": true})
	require.Equal(t, http.StatusOK, code, "%v", body)
	assert.Equal(t, "index.html", tracked(full), "with the choice the first commit holds the folder's files, so a run's worktree has them")
}

// #17211: a first commit that includes the folder's files leaves out the ones named like secrets, even when .gitignore does not list them, and says which.
func TestInitJobRepoLeavesOutSecretLookingFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	dir := t.TempDir()
	for name, text := range map[string]string{"main.go": "package main", ".env": "TOKEN=1", "deploy.pem": "x", "id_rsa": "x", "credentials.json": "{}", ".env.example": "TOKEN=", "sub/server.key": "x", "sub/ok.txt": "ok"} {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600))
	}
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": dir, "include_files": true})
	require.Equal(t, http.StatusOK, code, "%v", body)
	out, err := consoletest.HiddenCommand("git", "-C", dir, "ls-tree", "-r", "--name-only", "HEAD").Output()
	require.NoError(t, err)
	committed := strings.Fields(string(out))
	assert.ElementsMatch(t, []string{"main.go", ".env.example", "sub/ok.txt"}, committed, "no secret-looking file is in the commit")
	left, _ := body["left_out"].([]any)
	assert.Len(t, left, 5, "and the answer names them: %v", body["left_out"])
	_, err = os.Stat(filepath.Join(dir, ".env"))
	assert.NoError(t, err, "the files themselves stay where they are")
}

// #17211: the count the dialog shows is of files, subfolders included, and a folder past the limit is refused for a first commit with its files (nothing staged).
func TestInitJobRepoCountsFilesAndRefusesAHugeFolder(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "big", "deep"), 0o755))
	for i := 0; i < 7; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "big", "deep", "f"+strconv.Itoa(i)), []byte("x"), 0o644))
	}
	n, capped := countFolderFiles(dir, 100)
	assert.Equal(t, 7, n, "one folder holding seven files is seven files, not one")
	assert.False(t, capped)
	old := maxFirstCommitFiles
	maxFirstCommitFiles = 5
	t.Cleanup(func() { maxFirstCommitFiles = old })
	n, capped = countFolderFiles(dir, 5)
	assert.True(t, capped, "past the limit it says so, and stops counting")
	code, body := sendJSON(t, http.MethodPost, srv.URL+"/api/scheduled/jobs/init-repo", map[string]any{"repo_path": dir, "include_files": true})
	assert.Equal(t, http.StatusBadRequest, code)
	assert.Contains(t, body["error"], "too many for a first commit")
	_, err := os.Stat(filepath.Join(dir, ".git", "index"))
	assert.True(t, err != nil, "nothing was staged")
}

// #17211: when the first commit fails after the files were staged, the index is put back, so the folder is as before.
func TestAFailedFirstCommitLeavesNothingStaged(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	require.NoError(t, consoletest.HiddenCommand("git", "init", "-q", dir).Run())
	require.NoError(t, os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a"), 0o644))
	require.NoError(t, consoletest.HiddenCommand("git", "-C", dir, "add", "-A").Run()) // half-staged, as after a timeout
	unstage(dir)
	out, err := consoletest.HiddenCommand("git", "-C", dir, "diff", "--cached", "--name-only").Output()
	require.NoError(t, err)
	assert.Empty(t, strings.TrimSpace(string(out)), "the index is empty again")
}
