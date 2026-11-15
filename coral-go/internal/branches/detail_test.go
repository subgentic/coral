package branches

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestABranchOpensToItsCommitsAndFilesOverTheBase(t *testing.T) {
	_, feature, _ := repoWithWorktrees(t)
	c := New()
	c.For(feature)
	c.Observe(context.Background(), []string{feature})
	repo, i, ok := c.For(feature)
	require.True(t, ok)

	d, found, err := c.Detail(context.Background(), repo, repo.Worktrees[i].Head)
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "main", d.Base)
	require.Len(t, d.Commits, 2, "the two commits feature has and main does not")
	assert.Equal(t, "two.txt", d.Commits[0].Subject, "newest first")
	assert.Equal(t, "one.txt", d.Commits[1].Subject)
	assert.Equal(t, "t", d.Commits[0].Author, "what git records: the machine's git user, not an agent")
	assert.Len(t, d.Commits[0].ID, 12)
	assert.NotEmpty(t, d.Commits[0].At)
	var paths []string
	for _, f := range d.Files {
		paths = append(paths, f.Path)
	}
	assert.ElementsMatch(t, []string{"one.txt", "two.txt"}, paths)

	_, found, err = c.Detail(context.Background(), repo, "deadbeefdeadbeef")
	require.NoError(t, err)
	assert.False(t, found, "a head that is no worktree's is not read")
	_, found, _ = c.Detail(context.Background(), repo, "abc")
	assert.False(t, found, "a short prefix is not enough")
}

func TestOnlyACommitIdRangeRunsForLogAndDiff(t *testing.T) {
	a, b := strings.Repeat("a", 40), strings.Repeat("b", 40)
	assert.True(t, readAllowed([]string{"log", "--max-count=51", "--format=%H%x1f%an%x1f%aI%x1f%s", "--end-of-options", a + ".." + b}))
	assert.True(t, readAllowed([]string{"diff", "--numstat", "--no-renames", "--end-of-options", a + "..." + b}))
	for _, args := range [][]string{
		{"log", "--end-of-options", "main"}, {"log", a + ".." + b}, {"log", "--end-of-options", "--all"}, {"log", "-p", "--end-of-options", a + ".." + b},
		{"diff", "--end-of-options", "HEAD"}, {"diff", "--output=/tmp/x", "--end-of-options", a + ".." + b}, {"diff", "--ext-diff", "--end-of-options", a + ".." + b},
	} {
		assert.False(t, readAllowed(args), "%v", args)
	}
}
