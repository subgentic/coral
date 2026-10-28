package routes

import (
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10276: a plain folder, or a repository with no commit, is made a repository a job can run in when the person agrees: git init when needed, then one empty first commit.
func TestInitJobRepoMakesAFolderAJobCanRunIn(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	srv, _ := scheduleTestServer(t)
	commits := func(dir string) string {
		out, _ := exec.Command("git", "-C", dir, "rev-list", "--count", "HEAD").Output()
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
	require.NoError(t, exec.Command("git", "init", "-q", empty).Run()) // a repository with no commit yet
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
