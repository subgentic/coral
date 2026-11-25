package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// submit-review says which commit from which folder it sends, and warns from the shared checkout or a branch named main (#18457).
func TestSubmitReviewNamesTheHeadAndWarnsFromTheSharedCheckout(t *testing.T) {
	root := t.TempDir()
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run(root, "init", "-q", "-b", "main")
	run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one")
	wt := filepath.Join(t.TempDir(), "task-wt")
	run(root, "worktree", "add", "-q", "-b", "task-branch", wt)

	var shared bytes.Buffer
	announceHead(&shared, root, "abc1234567")
	assert.Contains(t, shared.String(), "submitting abc1234567 from ")
	assert.Contains(t, shared.String(), "warning: this is the shared checkout")

	var linked bytes.Buffer
	announceHead(&linked, wt, "abc1234567")
	assert.Contains(t, linked.String(), "submitting abc1234567 from ")
	assert.NotContains(t, linked.String(), "warning", "a worktree on its own branch is not warned about")

	wt2 := filepath.Join(t.TempDir(), "other-wt")
	run(root, "worktree", "add", "-q", "-b", "master", wt2)
	var onMain bytes.Buffer
	announceHead(&onMain, wt2, "abc1234567")
	assert.Contains(t, onMain.String(), "warning: this is a worktree")
}

// #21445: from a SUBDIRECTORY of the shared checkout (an agent's shell sits in coral-go/) git prints --git-dir as an absolute path and --git-common-dir as "../.git", so the two compared unequal and the shared
// checkout's HEAD was recorded as the submitted head (6ae19d57bd, three times on 2026-11-25). The folder is the shared checkout whatever directory of it the command runs in.
func TestSubmitReviewFromASubdirectoryOfTheSharedCheckoutIsStillTheSharedCheckout(t *testing.T) {
	root := t.TempDir()
	run := func(dir string, args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run(root, "init", "-q", "-b", "work")
	run(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one")
	sub := filepath.Join(root, "coral-go")
	require.NoError(t, os.MkdirAll(sub, 0o755))
	var out bytes.Buffer
	assert.False(t, announceHead(&out, sub, "abc1234567"), out.String())
	assert.Contains(t, out.String(), "the shared checkout")
	wt := filepath.Join(t.TempDir(), "task-wt")
	run(root, "worktree", "add", "-q", "-b", "task-branch", wt)
	require.NoError(t, os.MkdirAll(filepath.Join(wt, "coral-go"), 0o755))
	var linked bytes.Buffer
	assert.True(t, announceHead(&linked, filepath.Join(wt, "coral-go"), "abc1234567"), "a subdirectory of a task worktree is a worktree: "+linked.String())
}

// #21445: the head a submit records is the worktree's, and none when the folder is the shared checkout or the commit is not on origin; the note says how to name it.
func TestDefaultSubmitHeadIsTheWorktreesOrNone(t *testing.T) {
	root := t.TempDir()
	run := func(dir string, args ...string) string {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	origin := filepath.Join(t.TempDir(), "origin.git")
	run(root, "init", "-q", "--bare", origin)
	repo := filepath.Join(t.TempDir(), "repo")
	run(root, "init", "-q", "-b", "main", repo)
	run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one")
	run(repo, "remote", "add", "origin", origin)
	run(repo, "push", "-q", "origin", "main")
	wt := filepath.Join(t.TempDir(), "task-wt")
	run(repo, "worktree", "add", "-q", "-b", "task-branch", wt)
	run(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two")

	var out bytes.Buffer
	assert.Empty(t, defaultSubmitHead(&out, filepath.Join(repo)), "the shared checkout: no head")
	assert.Contains(t, out.String(), "--head <sha>")
	out.Reset()
	assert.Empty(t, defaultSubmitHead(&out, wt), "a worktree whose commit is not on origin: no head")
	assert.Contains(t, out.String(), "not on origin")
	assert.Contains(t, out.String(), "--head <sha>")
	run(wt, "push", "-q", "origin", "task-branch")
	out.Reset()
	assert.Equal(t, run(wt, "rev-parse", "HEAD"), defaultSubmitHead(&out, wt), "pushed worktree: its head")
}
