package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17992: submit-review says whether the head it sends is at the tip of a branch on origin, and whether it ran in the shared checkout rather than a worktree.
func TestSubmitReviewChecksTheHeadOnOriginAndTheCheckout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	origin := root + "/origin.git"
	require.NoError(t, exec.Command("git", "init", "-q", "--bare", origin).Run())
	repo := root + "/repo"
	require.NoError(t, exec.Command("git", "clone", "-q", origin, repo).Run())
	git(repo, "checkout", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(repo+"/a.txt", []byte("a\n"), 0o644))
	git(repo, "add", "-A")
	git(repo, "commit", "-q", "-m", "one")
	git(repo, "push", "-q", "origin", "main")
	pushed := git(repo, "rev-parse", "HEAD")
	require.NoError(t, os.WriteFile(repo+"/b.txt", []byte("b\n"), 0o644))
	git(repo, "add", "-A")
	git(repo, "commit", "-q", "-m", "two")
	unpushed := git(repo, "rev-parse", "HEAD")
	wt := root + "/wt"
	git(repo, "worktree", "add", "-q", "--detach", wt)

	t.Chdir(repo)
	assert.Equal(t, "found", headOnOrigin(pushed), "a pushed branch tip")
	assert.Equal(t, "found", headOnOrigin(pushed[:9]), "a short head matches by prefix")
	assert.Equal(t, "missing", headOnOrigin(unpushed), "a commit that was never pushed")
	assert.True(t, inSharedCheckout(), "the repository's own checkout is shared")
	t.Chdir(wt)
	assert.False(t, inSharedCheckout(), "a linked worktree is not")
	t.Chdir(t.TempDir()) // a folder with no repository (not root: git also reads a bare 'origin' as the folder origin.git beside it)
	assert.False(t, inSharedCheckout(), "outside a repository there is nothing to warn about")
	assert.Equal(t, "unchecked", headOnOrigin(pushed), "no repository: origin cannot be asked")
}
