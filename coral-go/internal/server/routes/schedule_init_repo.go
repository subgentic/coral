// Make a job's folder a git repository (#10276): a plain folder, or a repository with no commit yet, is not one a job can run in (each run works in a worktree of it). The person is asked first; this
// does what they agreed to: git init when the folder is not a repository, then one empty first commit.

package routes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/safefs"
)

// jobFolderError is jobRepoError plus the first commit a worktree is made from: "" when the folder is a repository with at least one commit.
func jobFolderError(ctx context.Context, dir string) string {
	if msg := jobRepoError(ctx, dir); msg != "" {
		return msg
	}
	resolved, err := canonicalizeRepoPath(dir)
	if err != nil {
		return "repo_path is not an existing directory: " + dir
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := gitutil.Command(cctx, resolved, "rev-parse", "--verify", "--quiet", "HEAD").Run(); err != nil {
		return "repo_path has no commit yet: " + dir
	}
	return ""
}

// jobFolderErrorFor is the check a job's folder gets when it is saved: a repository with a commit when its runs work in a worktree, any existing folder when they work in the folder itself (#10276).
func jobFolderErrorFor(ctx context.Context, dir string, noWorktree bool) string {
	if !noWorktree {
		return jobFolderError(ctx, dir)
	}
	if _, err := canonicalizeRepoPath(dir); err != nil {
		return "repo_path is not an existing directory: " + dir
	}
	return ""
}

// InitJobRepo makes the folder a repository with one empty commit, as the person asked in the New job dialog.
// POST /api/scheduled/jobs/init-repo {"repo_path": "..."}
func (h *ScheduleHandler) InitJobRepo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RepoPath string `json:"repo_path"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.RepoPath) == "" {
		errBadRequest(w, "repo_path is required")
		return
	}
	dir, err := canonicalizeRepoPath(strings.TrimSpace(body.RepoPath))
	if err != nil {
		errBadRequest(w, "repo_path is not an existing directory: "+body.RepoPath)
		return
	}
	if home, herr := os.UserHomeDir(); (herr == nil && sameDir(dir, home)) || filepath.Dir(dir) == dir {
		errBadRequest(w, "Pick a project folder, not the home folder or the root of the disk: a repository there would hold everything in it.")
		return
	}
	if !gitutil.Available() {
		errBadRequest(w, "git is not installed on this computer")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if !gitutil.IsWorkTree(ctx, dir) {
		if out, err := gitutil.Command(ctx, dir, "init").CombinedOutput(); err != nil {
			errBadRequest(w, "git init failed: "+strings.TrimSpace(string(out)))
			return
		}
	}
	if jobFolderError(ctx, dir) == "" { // already a repository with a commit (a second click, or another window made it): nothing to add
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repo_path": dir, "created": false})
		return
	}
	args := []string{}
	for key, fallback := range map[string]string{"user.name": "Coral", "user.email": "coral@localhost"} { // the person's own identity when git has one; a placeholder only when it has none
		if out, _ := gitutil.Command(ctx, dir, "config", key).Output(); strings.TrimSpace(string(out)) == "" {
			args = append(args, "-c", key+"="+fallback)
		}
	}
	args = append(args, "commit", "--allow-empty", "--no-verify", "-m", "Initial commit")
	if out, err := gitutil.Command(ctx, dir, args...).CombinedOutput(); err != nil {
		errBadRequest(w, "the first commit failed: "+strings.TrimSpace(string(out)))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repo_path": dir, "created": true})
}

// sameDir reports whether two directories are the same, links resolved.
func sameDir(a, b string) bool {
	ra, ea := safefs.Resolve(a) // follows Windows junctions too, which filepath.EvalSymlinks does not (the routes lint)
	rb, eb := safefs.Resolve(b)
	return ea == nil && eb == nil && ra == rb
}
