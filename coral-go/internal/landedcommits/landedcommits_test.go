package landedcommits

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gitutil"
)

// git runs one git command in dir through gitutil.Command, with an identity and a committer date of the test's own.
func git(t *testing.T, dir, author, date string, args ...string) {
	t.Helper()
	cmd := gitutil.Command(context.Background(), dir, args...)
	cmd.Env = append(cmd.Env, "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_AUTHOR_NAME="+author, "GIT_AUTHOR_EMAIL=a@example.invalid",
		"GIT_COMMITTER_NAME=Committer", "GIT_COMMITTER_EMAIL=c@example.invalid", "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
}

func commit(t *testing.T, dir, author, date, file string) {
	t.Helper()
	require.NoError(t, os.WriteFile(filepath.Join(dir, file), []byte(file+date), 0o644))
	git(t, dir, author, date, "add", file)
	git(t, dir, author, date, "commit", "-q", "-m", "work on "+file)
}

func newRepo(t *testing.T, branch string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	require.NoError(t, err)
	git(t, dir, "x", "2026-10-01T00:00:00Z", "init", "-q", "-b", branch)
	return dir
}

func TestReadsTheMainBranchesCommitsInTheWindowWithTheirAuthors(t *testing.T) {
	root := newRepo(t, "main")
	commit(t, root, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	commit(t, root, "QA Engineer", "2026-10-22T10:00:00Z", "b.txt")
	commit(t, root, "Backend Dev", "2026-10-23T10:00:00Z", "c.txt")
	commit(t, root, "Someone Else", "2026-10-24T10:00:00Z", "d.txt")
	git(t, root, "x", "2026-10-24T11:00:00Z", "checkout", "-q", "-b", "side")
	commit(t, root, "Side Branch Dev", "2026-10-24T12:00:00Z", "e.txt") // not on main: never counted
	git(t, root, "x", "2026-10-24T13:00:00Z", "checkout", "-q", "main")

	since := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	until := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	got, capped, err := Read(context.Background(), root, "main", since, until)
	require.NoError(t, err)
	assert.False(t, capped)
	var authors []string
	for _, c := range got {
		authors = append(authors, c.Author)
		assert.Regexp(t, `^[0-9a-f]{40}$`, c.Hash)
		assert.Regexp(t, `^2026-10-2\dT\d\d:00:00Z$`, c.At)
	}
	assert.Equal(t, []string{"Someone Else", "Backend Dev", "QA Engineer"}, authors, "newest first, the window only, main only")

	// the window's end is exclusive and its start inclusive
	got, _, err = Read(context.Background(), root, "main", time.Date(2026, 10, 23, 10, 0, 0, 0, time.UTC), time.Date(2026, 10, 24, 10, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Backend Dev", got[0].Author)
}

func TestMergeCommitsAreNotCounted(t *testing.T) {
	root := newRepo(t, "main")
	commit(t, root, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	git(t, root, "x", "2026-10-21T10:00:00Z", "checkout", "-q", "-b", "feature")
	commit(t, root, "Frontend Dev", "2026-10-21T11:00:00Z", "f.txt")
	git(t, root, "x", "2026-10-21T12:00:00Z", "checkout", "-q", "main")
	commit(t, root, "QA Engineer", "2026-10-21T13:00:00Z", "q.txt")
	git(t, root, "Merger", "2026-10-21T14:00:00Z", "merge", "-q", "--no-ff", "-m", "merge feature", "feature")
	got, _, err := Read(context.Background(), root, "main", time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	var authors []string
	for _, c := range got {
		authors = append(authors, c.Author)
	}
	assert.ElementsMatch(t, []string{"Backend Dev", "Frontend Dev", "QA Engineer"}, authors, "the merge commit itself is not a commit of anyone's work; the work it brought is")
}

func TestDefaultBranchAndCommonRoot(t *testing.T) {
	ctx := context.Background()
	root := newRepo(t, "main")
	commit(t, root, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	assert.Equal(t, "main", DefaultBranch(ctx, root))
	old := newRepo(t, "master")
	commit(t, old, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	assert.Equal(t, "master", DefaultBranch(ctx, old))
	empty := newRepo(t, "trunk")
	commit(t, empty, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	assert.Equal(t, "", DefaultBranch(ctx, empty), "no origin/HEAD, no main or master: none, never a guess")

	sub := filepath.Join(root, "pkg", "app")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	outside := t.TempDir()
	assert.Equal(t, root, CommonRoot(ctx, []string{sub, root, filepath.Join(root, "pkg"), old, outside, ""}), "the most common root: three of five")
	assert.Equal(t, "", CommonRoot(ctx, []string{outside, ""}), "none of them is in a repository")
	assert.Equal(t, "", CommonRoot(ctx, nil))
	a, b := root, old
	want := a
	if b < a {
		want = b
	}
	assert.Equal(t, want, CommonRoot(ctx, []string{root, old}), "a tie goes to the lexically first")
}

func TestARefThatIsNotABranchNameIsRefusedAndTheCacheKeepsAnswersForAMinute(t *testing.T) {
	root := newRepo(t, "main")
	commit(t, root, "Backend Dev", "2026-10-20T10:00:00Z", "a.txt")
	for _, bad := range []string{"", "--output=/tmp/x", "-n", "a b", "x\ny"} {
		_, _, err := Read(context.Background(), root, bad, time.Unix(0, 0), time.Now())
		assert.Error(t, err, "branch %q", bad)
	}
	now := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	c := &Cache{now: func() time.Time { return now }}
	since, until := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	got, _, err := c.Read(context.Background(), root, "main", since, until)
	require.NoError(t, err)
	require.Len(t, got, 1)
	commit(t, root, "QA Engineer", "2026-10-20T11:00:00Z", "b.txt")
	got, _, _ = c.Read(context.Background(), root, "main", since, until)
	assert.Len(t, got, 1, "inside the minute the answer is the cached one")
	now = now.Add(CacheTTL + time.Second)
	got, _, _ = c.Read(context.Background(), root, "main", since, until)
	assert.Len(t, got, 2, "after it, git is asked again")
}
