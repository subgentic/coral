package gitutil

import (
	"context"
	"path/filepath"
)

// commonDir is the repository directory that dir's checkout and all its linked worktrees share, as an absolute path with links resolved ("" when dir is no git working tree or git is not there).
func commonDir(ctx context.Context, dir string) string {
	out, err := git(ctx, dir, "rev-parse", "--git-common-dir")
	if err != nil || out == "" {
		return ""
	}
	if !filepath.IsAbs(out) {
		out = filepath.Join(dir, out)
	}
	if real, err := filepath.EvalSymlinks(out); err == nil {
		out = real
	}
	return filepath.Clean(out)
}

// SameRepo reports whether a and b are both git working trees of the one repository: the main checkout and its linked worktrees (#11704). It is how Coral decides it may follow an agent that has moved to
// another folder: only into a worktree of the repository it was launched in, never into whatever folder the agent names.
func SameRepo(ctx context.Context, a, b string) bool {
	ca := commonDir(ctx, a)
	return ca != "" && ca == commonDir(ctx, b)
}
