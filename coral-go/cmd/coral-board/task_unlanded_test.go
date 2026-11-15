package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	return strings.TrimSpace(string(out))
}

func TestHeadSHAIsTheOneAfterHeadElseTheFirstRealHexWord(t *testing.T) {
	assert.Equal(t, "593c17b672", headSHAFromText("", "Head 593c17b672 on qa-x (base 7ca240b821)"), "the base named after the head is not the head")
	assert.Equal(t, "74da127ae8", headSHAFromText("Model column (head 74da127ae8, branch qa on 7ca240b821)"))
	assert.Equal(t, "2010aa1b98", headSHAFromText("Download; at 2010aa1b98, stacked on 5d2ffdd95f"), "no 'head': the first commit-looking word after at, commit or sha")
	assert.Equal(t, "2010aa1b98", headSHAFromText("fixed in commit 2010aa1b98"))
	assert.Equal(t, "2010aa1b98", headSHAFromText("done, sha: 2010aa1b98"))
	assert.Equal(t, "", headSHAFromText("it effaced a deadbeef-less word, 1234567 digits only", "review pending"), "a word with no letter, or no digit, is not a commit")
	assert.Equal(t, "abc1234", headSHAFromText("", "Head: ABC1234."), "case and punctuation")
	// a base is never taken for the head (#18255): it would show the task as landed
	assert.Equal(t, "abc1234def", headSHAFromText("ready on main 7ca240b821, fix at abc1234def"), "main's word follows 'main', not an allow word")
	// an allow list, not a block list (#18302): a word before the commit that is not at, commit or sha takes none
	assert.Equal(t, "", headSHAFromText("rebased 7ca240b821"))
	assert.Equal(t, "", headSHAFromText("branched at-ish 7ca240b821, then 2010aa1b98"))
	assert.Equal(t, "", headSHAFromText("2010aa1b98 ready"), "a commit with no allow word before it")
	assert.Equal(t, "", headSHAFromText("fixed (base 7ca240b821)"))
	assert.Equal(t, "", headSHAFromText("", "based on 7ca240b821"))
	assert.Equal(t, "", headSHAFromText("stacked on 5d2ffdd95f"))
	assert.Equal(t, "", headSHAFromText("parent: 5d2ffdd95f"))
}

// Approved work whose head is not on the ref is listed, with the ones that name no commit; landed work, failed work, work outside the window and open work are not. Real git, in a temp repository.
func TestUnlandedListsApprovedTasksWhoseHeadIsNotOnTheRef(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	onMain := gitIn(t, repo, "rev-parse", "--short=10", "HEAD")
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "topic work")
	offMain := gitIn(t, repo, "rev-parse", "--short=10", "HEAD")
	gitIn(t, repo, "checkout", "-q", "main")
	before := gitIn(t, repo, "rev-parse", "HEAD")
	now := time.Now().UTC()
	day := func(n int) string { return now.Add(-time.Duration(n) * 24 * time.Hour).Format(time.RFC3339) }
	tasks := []map[string]any{
		{"id": 1.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "landed"},
		{"id": 2.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "approved, not on main"},
		{"id": 3.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "no sha in its text"},
		{"id": 4.0, "status": "completed", "outcome": "failed", "completed_at": day(1), "title": "failed"},
		{"id": 5.0, "status": "completed", "outcome": "success", "completed_at": day(30), "title": "too old"},
		{"id": 6.0, "status": "in_progress", "title": "open"},
		{"id": 7.0, "status": "completed", "outcome": "success", "completed_at": day(2), "title": "a commit this clone lacks"},
		{"id": 8.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "Review #2: approved, not on main"},
		{"id": 9.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "a review task by another name"},
		{"id": 10.0, "status": "completed", "outcome": "success", "completed_at": day(1), "title": "names only its base, which is on main"},
	}
	text := map[int64]string{1: "Head " + onMain, 2: "Head " + offMain, 3: "all done", 7: "Head 0123abc4567", 10: "ready, base " + onMain}
	detail := func(id int64) (map[string]any, error) {
		if id == 9 {
			return map[string]any{"workflow": map[string]any{"review_of": 2.0}}, nil
		}
		return map[string]any{"workflow": map[string]any{"completion_review": map[string]any{"message": text[id], "reason": "review pending"}}}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitLanded(repo, "main"))
	require.NoError(t, err)
	var ids []string
	for _, r := range got {
		ids = append(ids, fmt.Sprintf("%d:%s", r.ID, r.Why))
	}
	assert.Equal(t, []string{"2:not on main", "3:no head SHA recorded", "7:commit not in this repository (git fetch it)", "10:no head SHA recorded"}, ids)
	assert.Equal(t, offMain, got[0].SHA)
	assert.Equal(t, before, gitIn(t, repo, "rev-parse", "HEAD"), "read-only: the repository did not move")
	assert.Empty(t, gitIn(t, repo, "status", "--porcelain"))
	// the same work counts as landed once its branch is merged
	gitIn(t, repo, "merge", "-q", "--no-ff", "-m", "merge topic", "topic")
	got, err = findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitLanded(repo, "main"))
	require.NoError(t, err)
	for _, r := range got {
		assert.NotEqual(t, int64(2), r.ID, "a merged head is landed")
	}
}

func TestUnlandedWindowAndRefAreChecked(t *testing.T) {
	d, err := parseSince("7d")
	require.NoError(t, err)
	assert.Equal(t, 7*24*time.Hour, d)
	d, _ = parseSince("12h")
	assert.Equal(t, 12*time.Hour, d)
	d, _ = parseSince("2w")
	assert.Equal(t, 14*24*time.Hour, d)
	for _, bad := range []string{"", "d", "0d", "7", "7x", "-1d"} {
		_, err := parseSince(bad)
		assert.Error(t, err, bad)
	}
}
