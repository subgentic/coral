package gitutil

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #11704: Coral follows an agent that moved only into a worktree of the repository it was launched in: the same repository, never another folder the agent can name.
func TestSameRepoIsTrueForTheCheckoutAndItsWorktreesOnly(t *testing.T) {
	ctx := context.Background()
	repo := baseRepo(t, "master", true)
	wt := filepath.Join(t.TempDir(), "wt-a")
	gitIn(t, repo, "worktree", "add", "-b", "feat-a", "--", wt, "master")
	other := baseRepo(t, "master", true)
	plain := t.TempDir()

	assert.True(t, SameRepo(ctx, repo, wt), "the checkout and its worktree")
	assert.True(t, SameRepo(ctx, wt, repo), "and back")
	assert.True(t, SameRepo(ctx, wt, filepath.Join(wt, ".")), "a folder is its own repository's")
	assert.False(t, SameRepo(ctx, repo, other), "another repository is not followed")
	assert.False(t, SameRepo(ctx, repo, plain), "a folder that is no repository is not followed")
	assert.False(t, SameRepo(ctx, plain, repo), "nor is a launch folder that is none")
	assert.False(t, SameRepo(ctx, repo, filepath.Join(plain, "missing")), "a folder that is not there")
}
