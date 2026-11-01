package branches

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := consoletest.HiddenCommand("git", append([]string{"-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"}, args...)...)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// repoWithWorktrees: main has a base commit, then two more; "feature" (a worktree) has two commits of its own and a changed file; "picked" (a worktree) has one commit that main
// then cherry-picked, so it has nothing left to merge.
func repoWithWorktrees(t *testing.T) (main, feature, picked string) {
	t.Helper()
	main = t.TempDir()
	runGit(t, main, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(main, "a.txt"), []byte("a\n"), 0o644))
	runGit(t, main, "add", "a.txt")
	runGit(t, main, "commit", "-q", "-m", "base")

	feature = filepath.Join(t.TempDir(), "feature")
	runGit(t, main, "worktree", "add", "-q", "-b", "feature", feature)
	for _, f := range []string{"one.txt", "two.txt"} { // commits with changes of their own: --cherry-pick matches commits by their patch, and empty ones all match
		require.NoError(t, os.WriteFile(filepath.Join(feature, f), []byte(f), 0o644))
		runGit(t, feature, "add", f)
		runGit(t, feature, "commit", "-q", "-m", f)
	}
	require.NoError(t, os.WriteFile(filepath.Join(feature, "a.txt"), []byte("changed\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(feature, "new.txt"), []byte("n\n"), 0o644))

	picked = filepath.Join(t.TempDir(), "picked")
	runGit(t, main, "worktree", "add", "-q", "-b", "picked", picked)
	require.NoError(t, os.WriteFile(filepath.Join(picked, "p.txt"), []byte("p\n"), 0o644))
	runGit(t, picked, "add", "p.txt")
	runGit(t, picked, "commit", "-q", "-m", "picked change")
	runGit(t, main, "commit", "-q", "--allow-empty", "-m", "main moves") // so the cherry-picked copy is a commit of its own
	runGit(t, main, "cherry-pick", runGit(t, picked, "rev-parse", "HEAD"))
	return main, feature, picked
}

func TestARepositorysWorktreesAreReadWithTheirCountsAgainstTheBase(t *testing.T) {
	main, feature, picked := repoWithWorktrees(t)
	c := New()
	c.Observe(context.Background(), []string{feature})

	repo, i, ok := c.For(filepath.Join(feature, "sub-folder-that-need-not-exist", ".."))
	require.True(t, ok, "an agent in the feature worktree finds its repository")
	assert.Equal(t, "main", repo.Base)
	require.Len(t, repo.Worktrees, 3)
	byBranch := map[string]Worktree{}
	for _, w := range repo.Worktrees {
		byBranch[w.Branch] = w
	}
	assert.Equal(t, "feature", repo.Worktrees[i].Branch, "the agent's own worktree")
	assert.True(t, byBranch["main"].Main)
	f := byBranch["feature"]
	assert.Equal(t, 2, f.Ahead)
	assert.Equal(t, 2, f.Behind, "main moved, then took the cherry-pick")
	assert.False(t, f.NothingToMerge)
	assert.Equal(t, 1, f.Changed, "a.txt")
	assert.Equal(t, 1, f.Untracked, "new.txt")
	assert.Len(t, f.Head, 12)
	p := byBranch["picked"]
	assert.Equal(t, 1, p.Ahead)
	assert.True(t, p.NothingToMerge, "its one commit is already in main by cherry-pick")
	_, _, ok = c.For(t.TempDir())
	assert.False(t, ok, "a folder in no worktree")
	assert.True(t, repo.Holds(0, main), "the main worktree holds the main folder")
	assert.False(t, repo.Holds(0, picked))

	data, err := jsonOf(repo)
	require.NoError(t, err)
	for _, p := range []string{main, feature, picked, filepath.ToSlash(main)} {
		assert.NotContains(t, data, strings.ToLower(p), "no worktree path is served")
	}
}

func TestAWorktreeBeyondTheCapIsCountedNotDropped(t *testing.T) {
	main := t.TempDir()
	runGit(t, main, "init", "-q", "-b", "main")
	runGit(t, main, "commit", "-q", "--allow-empty", "-m", "base")
	for i := 0; i < MaxWorktrees+2; i++ {
		runGit(t, main, "worktree", "add", "-q", "--detach", filepath.Join(t.TempDir(), "w"))
	}
	c := New()
	c.Observe(context.Background(), []string{main})
	repo, _, ok := c.For(main)
	require.True(t, ok)
	assert.Len(t, repo.Worktrees, MaxWorktrees)
	assert.Equal(t, 3, repo.More, "23 worktrees (the main one and 22): 20 shown, 3 more")
	assert.True(t, repo.Worktrees[1].Detached)
}

// Security's MUST 2: a branch name that cleaning would change is not shown as a look-alike.
func TestABranchNameWithAHiddenCharacterIsNotShown(t *testing.T) {
	trees := parseWorktrees([]byte("worktree /r\x00HEAD 0123456789012345678901234567890123456789\x00branch refs/heads/main\x00\x00" +
		"worktree /r/w\x00HEAD 0123456789012345678901234567890123456789\x00branch refs/heads/ma‮in\x00\x00" +
		"worktree /r/b\x00bare\x00\x00"))
	require.Len(t, trees, 2, "a bare entry is not a worktree")
	assert.Equal(t, "main", trees[0].Branch)
	assert.Equal(t, "", trees[1].Branch)
	assert.True(t, trees[1].NameHidden)
	assert.Equal(t, strings.Repeat("x", maxBranchRunes-1)+"…", cleanName(strings.Repeat("x", 200)), "capped with an ellipsis")
}

// Security's MUST 1: only the read commands and their listed flags run, never a network or writing one, and git gets no GIT_* of Coral's own.
func TestOnlyReadCommandsWithTheirListedFlagsRun(t *testing.T) {
	for _, args := range [][]string{
		{"worktree", "list", "--porcelain", "-z"},
		{"rev-list", "--left-right", "--count", "--end-of-options", "a...b"},
		{"status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames", "--ignore-submodules=all"},
		{"rev-parse", "--verify", "--quiet", "--end-of-options", "refs/heads/main^{commit}"},
	} {
		assert.True(t, readAllowed(args), "%v", args)
	}
	for _, args := range [][]string{
		{"fetch"}, {"pull"}, {"ls-remote", "origin"}, {"remote", "update"}, {"worktree", "add", "x"}, {"worktree", "remove", "x"}, {"worktree", "prune"},
		{"checkout", "main"}, {"reset", "--hard"}, {"push"}, {"gc"}, {"config", "x"},
		{"status", "--porcelain=v1", "--untracked-files=all"}, {"rev-list", "--all"}, {"rev-parse", "--git-path", "x"}, {},
	} {
		assert.False(t, readAllowed(args), "%v", args)
		_, err := readGit(context.Background(), "", args...)
		assert.ErrorIs(t, err, errNotRead, "%v", args)
	}
	env := scrubGitEnv([]string{"PATH=/bin", "GIT_DIR=/elsewhere", "git_index_file=/x", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "GIT_CONFIG_PARAMETERS='x'"})
	assert.Equal(t, []string{"PATH=/bin", "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0"}, env)
}

func TestARepositoryIsReadAgainOnlyAfterItsInterval(t *testing.T) {
	main, feature, _ := repoWithWorktrees(t)
	c := New()
	now := time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	calls := 0
	c.run = func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		calls++
		return readGit(ctx, dir, args...)
	}
	c.Observe(context.Background(), []string{main, feature})
	first := calls
	require.Positive(t, first)
	c.Observe(context.Background(), []string{main, feature})
	assert.Equal(t, first, calls, "the same repository through two folders, read once; and not again within a minute")
	now = now.Add(refreshEvery)
	c.Observe(context.Background(), []string{feature})
	assert.Greater(t, calls, first)
	c.Observe(context.Background(), nil)
	_, _, ok := c.For(feature)
	assert.False(t, ok, "a repository no agent works in is forgotten")
}
