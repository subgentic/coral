package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"}, args...)...)
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

// The landing check lists a completed task whose commit is not an ancestor of main (#18181), and not one that is.
func TestUnlandedListsOnlyWhatIsNotOnMain(t *testing.T) {
	repo := t.TempDir()
	git(t, repo, "init", "-q", "-b", "main")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	onMain := git(t, repo, "rev-parse", "HEAD")
	git(t, repo, "checkout", "-q", "-b", "fix-17632")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "never landed")
	stranded := git(t, repo, "rev-parse", "HEAD")
	git(t, repo, "checkout", "-q", "main")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "landed work")
	landed := git(t, repo, "rev-parse", "HEAD")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "picked under a new id")
	git(t, repo, "checkout", "-q", "-b", "fix-17650", "main~1")
	git(t, repo, "commit", "-q", "--allow-empty", "-m", "picked under a new id")
	picked := git(t, repo, "rev-parse", "HEAD")
	git(t, repo, "checkout", "-q", "main")
	git(t, repo, "update-ref", "refs/remotes/origin/main", "main")
	git(t, repo, "update-ref", "refs/remotes/origin/fix-17632", stranded)
	git(t, repo, "update-ref", "refs/remotes/origin/fix-17700", stranded)

	rows, checked := findUnlanded(context.Background(), repo, "origin/main", []landTask{
		{ID: 17632, Title: "named by its submit reason", Texts: []string{"Files search fixed, " + stranded[:9], "", ""}},
		{ID: 17640, Title: "landed", Texts: []string{"fixed with a failing-first test, " + landed[:10], "", ""}},
		{ID: 17641, Title: "an old head, then the final one", Texts: []string{"first " + stranded[:8] + " then " + landed[:8], "", ""}},
		{ID: 17700, Title: "no sha in the words, found by its branch", Texts: []string{"done", "", ""}},
		{ID: 17650, Title: "cherry-picked: another id, same subject", Texts: []string{"done " + picked[:9], "", ""}},
		{ID: 17701, Title: "a task with nothing to check", Texts: []string{"a note, 1234567 is a number, deadbeef is not a commit", "", ""}},
		{ID: 17702, Title: "the sha is in the completion message", Texts: []string{"", "", "landed as " + onMain[:9]}},
	})
	assert.Equal(t, 6, checked, "the task with nothing to check is not counted")
	require.Len(t, rows, 2, "%+v", rows)
	assert.Equal(t, unlandedRow{Task: 17632, Title: "named by its submit reason", SHA: stranded, Branch: "fix-17632"}, rows[0])
	assert.Equal(t, int64(17700), rows[1].Task)
	assert.Equal(t, "fix-17700", rows[1].Branch)
}

func TestUnlandedOptions(t *testing.T) {
	since, main, repo, asJSON, err := unlandedArgs([]string{"--since", "2026-11-08", "--main=origin/release", "--repo", "/x", "--json"})
	require.NoError(t, err)
	assert.Equal(t, "2026-11-08", since.Format("2006-01-02"))
	assert.Equal(t, "origin/release", main)
	assert.Equal(t, "/x", repo)
	assert.True(t, asJSON)
	for _, bad := range [][]string{{"--since", "yesterday"}, {"--since"}, {"--main", "--json"}, {"--bogus"}} {
		_, _, _, _, err := unlandedArgs(bad)
		assert.Error(t, err, "%v", bad)
	}
}
