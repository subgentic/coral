package gitutil

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10054: the last commit alone is HEAD~1..HEAD (two refs, no working tree); a repository with one commit shows that whole commit; with no commit there is nothing to bound.
func TestDiffRefsAndLabelsForEveryComparison(t *testing.T) {
	ctx := context.Background()
	dir := baseRepo(t, "main", false)
	run := func(args ...string) string {
		out, err := exec.Command("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t"}, args...)...).CombinedOutput()
		require.NoError(t, err, string(out))
		return string(out)
	}
	assert.Equal(t, []string{emptyTreeSHA1}, DiffRefs(ctx, dir, DiffLastCommit), "no commit: the empty tree, nothing to bound with HEAD")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644))
	run("add", "-A")
	run("commit", "-q", "-m", "one")
	assert.Equal(t, []string{emptyTreeSHA1, "HEAD"}, DiffRefs(ctx, dir, DiffLastCommit), "one commit: that whole commit is the last commit")

	require.NoError(t, os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b\n"), 0o644))
	run("add", "-A")
	run("commit", "-q", "-m", "two")
	assert.Equal(t, []string{"HEAD~1", "HEAD"}, DiffRefs(ctx, dir, DiffLastCommit))
	assert.Equal(t, []string{"HEAD"}, DiffRefs(ctx, dir, DiffUncommitted))
	assert.Equal(t, []string{"HEAD~1"}, DiffRefs(ctx, dir, DiffPreviousCommit))
	assert.Equal(t, []string{"HEAD"}, DiffRefs(ctx, dir, DiffBranchPoint), "on main the branch point is HEAD")

	assert.False(t, IncludesWorkingTree(DiffLastCommit))
	for _, m := range []string{DiffUncommitted, DiffPreviousCommit, DiffBranchPoint, DiffMainHead, ""} {
		assert.True(t, IncludesWorkingTree(m), m)
	}
	assert.Equal(t, "Uncommitted changes", CompareLabel(ctx, dir, DiffUncommitted))
	assert.Equal(t, "Last commit", CompareLabel(ctx, dir, DiffLastCommit))
	assert.Contains(t, CompareLabel(ctx, dir, DiffBranchPoint), "Uncommitted changes", "on main the words say HEAD, not a merge-base")
	run("checkout", "-q", "-b", "feature")
	assert.Equal(t, "Changes since the branch point", CompareLabel(ctx, dir, DiffBranchPoint))
}
