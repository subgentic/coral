package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

// #3558: the poller records a remote URL without the credential embedded in it.
func TestQueryGitStripsRemoteCredentials(t *testing.T) {
	repo := t.TempDir()
	run := func(args ...string) {
		cmd := consoletest.HiddenCommand("git", append([]string{"-C", repo, "-c", "user.email=t@example.test", "-c", "user.name=t"}, args...)...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run("init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "f"), []byte("x"), 0o644))
	run("add", ".")
	run("commit", "-q", "-m", "c")
	run("remote", "add", "origin", "https://user:ghp_SECRET3558@github.com/org/repo.git")
	info, err := queryGit(context.Background(), repo)
	require.NoError(t, err)
	require.NotNil(t, info.RemoteURL)
	assert.Equal(t, "https://github.com/org/repo.git", *info.RemoteURL)
}

// #3558 SHOULD 1: the repo name a PR check uses never carries a credential either.
func TestGetRepoFromWorkdirStripsCredentials(t *testing.T) {
	repo := t.TempDir()
	out, err := consoletest.HiddenCommand("git", "-C", repo, "init", "-q").CombinedOutput()
	require.NoError(t, err, string(out))
	out, err = consoletest.HiddenCommand("git", "-C", repo, "remote", "add", "origin", "https://user:ghp_SECRET3558@git.example.test/org/repo.git?t=X").CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Equal(t, "https://git.example.test/org/repo", getRepoFromWorkdir(context.Background(), repo))
}
