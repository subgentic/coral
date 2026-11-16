package main

import (
	"bytes"
	"os/exec"
	"path/filepath"
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
