package branches

import (
	"context"
	"errors"
	"os/exec"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// exitError is what exec gives for a command that exited with code.
func exitError(t *testing.T, code string) error {
	t.Helper()
	err := exec.Command("sh", "-c", "exit "+code).Run()
	var ee *exec.ExitError
	require.True(t, errors.As(err, &ee))
	return err
}

// #20036: git before 2.36 refuses `worktree list -z` (exit 129, unknown switch). The tab must still list the worktrees, from the newline form, and never fail on an older git.
func TestAnOlderGitThatRefusesZStillListsTheWorktrees(t *testing.T) {
	main, feature, picked := repoWithWorktrees(t)
	refuse := exitError(t, "129")
	var sawZ, sawPlain bool
	c := New()
	c.run = func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "worktree" {
			if slices.Contains(args, "-z") {
				sawZ = true
				return nil, refuse // the old git's "unknown switch z"
			}
			sawPlain = true
			// the old git writes the newline form: a real git's -z output with each NUL turned into a newline
			out, err := readGit(ctx, dir, append(slices.Clone(args), "-z")...)
			for i := range out {
				if out[i] == 0 {
					out[i] = '\n'
				}
			}
			return out, err
		}
		return readGit(ctx, dir, args...)
	}
	c.For(feature)
	c.Observe(context.Background(), []string{feature})
	repo, _, ok := c.For(feature)
	require.True(t, ok)
	assert.True(t, sawZ && sawPlain, "-z is tried first, the plain form after its refusal")
	assert.False(t, repo.Unreadable)
	require.Len(t, repo.Worktrees, 3)
	byBranch := map[string]Worktree{}
	for _, w := range repo.Worktrees {
		byBranch[w.Branch] = w
	}
	assert.True(t, byBranch["main"].Main)
	assert.Equal(t, 2, byBranch["feature"].Ahead)
	assert.NotEmpty(t, byBranch["picked"].Branch)
	_, _ = main, picked

	// any other failure is still an unreadable repository, not a retry
	calls := 0
	d := New()
	d.run = func(ctx context.Context, dir string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "worktree" {
			calls++
			return nil, exitError(t, "1")
		}
		return readGit(ctx, dir, args...)
	}
	assert.True(t, d.read(context.Background(), feature).Unreadable)
	assert.Equal(t, 1, calls, "an exit other than 129 is not retried")
}

func TestTheNewlineFormIsParsedLikeTheNULForm(t *testing.T) {
	nl := parseWorktrees([]byte("worktree /r\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/main\n\n" +
		"worktree /r/w\nHEAD 0123456789012345678901234567890123456789\ndetached\n\n" +
		"worktree \"/r/odd\\nname\"\nHEAD 0123456789012345678901234567890123456789\nbranch refs/heads/x\n\n" +
		"worktree /r/b\nbare\n\n"))
	require.Len(t, nl, 3, "a bare entry is not a worktree")
	assert.Equal(t, "main", nl[0].Branch)
	assert.True(t, nl[0].Main)
	assert.True(t, nl[1].Detached)
	assert.False(t, localFixedPath(nl[2].raw), "a path git had to quote is not an absolute path: shown as not local, never opened")
}
