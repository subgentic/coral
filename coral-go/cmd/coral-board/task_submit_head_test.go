package main

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #19263: the commit an author names with --head is the commit recorded, whatever folder the command runs in (the folder's HEAD is only the default when --head is not given).
func TestSubmitReviewSendsTheHeadItWasGiven(t *testing.T) {
	gs := newGoalServer(t)
	for _, args := range [][]string{
		{"task", "submit-review", "5", "--head", "abc1234def5678", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s"},
		{"task", "submit-review", "5", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s", "--head", "abc1234def5678"},
		{"task", "submit-review", "5", "--head=abc1234def5678", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s"},
	} {
		res := goalRun(t, gs, args...)
		var sent string
		for _, r := range gs.requests() {
			if strings.Contains(r, "completion-review") || strings.Contains(r, "submit") {
				sent = r
			}
		}
		require.NotEmpty(t, sent, "stdout %q stderr %q requests %v", res.stdout, res.stderr, gs.requests())
		assert.Contains(t, sent, `"head":"abc1234def5678"`, strings.Join(args, " "))
		assert.NotContains(t, sent, worktreeHead(""), "the folder's HEAD is not what was named")
	}
}

// #19263, #21445: from the shared checkout (or main) with no --head, submit-review records no head rather than send that folder's HEAD; --branch names the work.
func TestSubmitReviewRefusesTheSharedCheckoutsHeadAndTakesABranch(t *testing.T) {
	root := t.TempDir()
	git := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		cmd.Dir = root
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	git("init", "-q", "-b", "main")
	git("commit", "-q", "--allow-empty", "-m", "one")
	git("branch", "task-branch")
	git("commit", "-q", "--allow-empty", "-m", "two") // main moves on: its HEAD is not the task's
	mainHead, branchTip := git("rev-parse", "HEAD"), git("rev-parse", "task-branch")
	require.NotEqual(t, mainHead, branchTip)
	t.Chdir(root)

	gs := newGoalServer(t)
	res := goalRun(t, gs, "task", "submit-review", "5", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s")
	assert.Equal(t, 0, res.code, "#21445: a submit from the shared checkout goes with no head (a submit with no code needs none), not refused: "+res.stderr)
	assert.Contains(t, res.stderr, "--head <sha>")
	for _, r := range gs.requests() {
		assert.NotContains(t, r, mainHead, "nothing was sent")
	}

	res = goalRun(t, gs, "task", "submit-review", "5", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s", "--branch", "task-branch")
	require.Equal(t, 0, res.code, res.stderr)
	var sent string
	for _, r := range gs.requests() {
		sent = r
	}
	assert.Contains(t, sent, `"head":"`+branchTip+`"`)
	assert.NotContains(t, sent, mainHead)

	res = goalRun(t, gs, "task", "submit-review", "5", "--reason", "r", "--message", "ok  \tgithub.com/x/pkg\t0.1s", "--branch", "nope")
	assert.Equal(t, 1, res.code)
}
