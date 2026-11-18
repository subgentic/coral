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

// shortHead is HEAD's 10-digit name, re-made (amended) until it holds a letter and a digit: headSHAFromText refuses a word of only digits or only letters, so a test that names a head must not depend on luck.
func shortHead(t *testing.T, dir string) string {
	t.Helper()
	for i := 0; i < 50; i++ {
		if s := gitIn(t, dir, "rev-parse", "--short=10", "HEAD"); hasLetterAndDigit(s) {
			return s
		}
		gitIn(t, dir, "commit", "-q", "--amend", "--allow-empty", "-m", fmt.Sprintf("%s (retry %d)", gitIn(t, dir, "log", "-1", "--format=%s"), i))
	}
	t.Fatal("no head name with a letter and a digit in 50 tries")
	return ""
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
	assert.Equal(t, "", headSHAFromText("branched at 7ca240b821"), "the base, even after 'at'")
	assert.Equal(t, "", headSHAFromText("based at 7ca240b821; rebased at 5d2ffdd95f"))
	assert.Equal(t, "2010aa1b98", headSHAFromText("branched at 7ca240b821, fixed at 2010aa1b98"))
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
	onMain := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "topic work")
	offMain := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "main")
	before := gitIn(t, repo, "rev-parse", "HEAD")
	now := time.Now().UTC()
	day := func(n int) string { return now.Add(-time.Duration(n) * 24 * time.Hour).Format(time.RFC3339) }
	tasks := []map[string]any{
		{"id": 1.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "landed"},
		{"id": 2.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "approved, not on main"},
		{"id": 3.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "no sha in its text"},
		{"id": 4.0, "status": "completed", "outcome": "failed", "completed_at": day(1), "title": "failed"},
		{"id": 5.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(30), "title": "too old"},
		{"id": 6.0, "status": "in_progress", "title": "open"},
		{"id": 7.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(2), "title": "a commit this clone lacks"},
		{"id": 8.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "Review #2: approved, not on main"},
		{"id": 9.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "a review task by another name"},
		{"id": 10.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day(1), "title": "names only its base, which is on main"},
	}
	text := map[int64]string{1: "Head " + onMain, 2: "Head " + offMain, 3: "all done", 7: "Head 0123abc4567", 10: "ready, base " + onMain}
	detail := func(id int64) (map[string]any, error) {
		if id == 9 {
			return map[string]any{"workflow": map[string]any{"review_of": 2.0}}, nil
		}
		return map[string]any{"workflow": map[string]any{"completion_review": map[string]any{"message": text[id], "reason": "review pending"}}}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
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
	got, err = findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
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

// A pick lands under another SHA (#18373): the ref has the same patch, or its log names the task. A real repository: a cherry-pick, a rebase, a trial merge with the task in its subject, and a branch whose patch is not on the ref.
func TestUnlandedCountsAPickAndATaskNamedOnTheRefAsLanded(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	write := func(name, body string) { require.NoError(t, os.WriteFile(repo+"/"+name, []byte(body), 0o644)) }
	write("base.txt", "base\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "base")
	branch := func(name, file string) string {
		gitIn(t, repo, "checkout", "-q", "-b", name, "main")
		write(file, name+"\n")
		gitIn(t, repo, "add", "-A")
		gitIn(t, repo, "commit", "-q", "-m", name+" work")
		sha := shortHead(t, repo)
		gitIn(t, repo, "checkout", "-q", "main")
		return sha
	}
	picked, named, unsent := branch("picked", "p.txt"), branch("named", "n.txt"), branch("unsent", "u.txt")
	write("other.txt", "main moved\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "main moves on")
	gitIn(t, repo, "cherry-pick", "picked") // on a moved main: a new SHA, the same patch
	require.NotEqual(t, picked, shortHead(t, repo))
	gitIn(t, repo, "merge", "-q", "--no-ff", "--no-commit", "named")
	gitIn(t, repo, "commit", "-q", "-m", "Merge a head into the trial (#302)")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	tasks := []map[string]any{
		{"id": 301.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "cherry-picked"},
		{"id": 302.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "named in a merge subject"},
		{"id": 303.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "not on the ref"},
		{"id": 304.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "its commit is unknown here, the log names it"},
	}
	heads := map[int64]string{301: picked, 302: named, 303: unsent, 304: "0123abc4567"}
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "Merge 0123abc4567 into the trial (#304)")
	detail := func(id int64) (map[string]any, error) {
		return map[string]any{"workflow": map[string]any{"completion_review": map[string]any{"message": "Head " + heads[id]}}}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	require.Len(t, got, 1, "%v", got)
	assert.Equal(t, int64(303), got[0].ID, "only the branch whose patch and number are not on main is unlanded")
	assert.Equal(t, "not on main", got[0].Why)
}

// The commit an approval names is the head that must land, not the first one a submit named (#18373): #18082 and #18092 showed '-', #18255 an early head.
func TestUnlandedUsesTheApprovedHeadBeforeTheSubmittedOne(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	onMain := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "topic work")
	off := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "main")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	tasks := []map[string]any{
		{"id": 1.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "early head landed, approved head not"},
		{"id": 2.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "no head in the submit, the approval has it"},
		{"id": 3.0, "status": "completed", "outcome": "success", "reviewers": []any{"Security Reviewer"}, "completed_at": day, "title": "approved head is on main"},
	}
	round := func(res, note string) map[string]any {
		return map[string]any{"workflow": nil, "result": res, "reviewers": []any{map[string]any{"state": res, "note": note}}}
	}
	detail := func(id int64) (map[string]any, error) {
		rounds := map[int64][]any{
			1: {round("rejected", "Rejected "+onMain), round("approved", "Approved "+off+", code read")},
			2: {round("approved", "Approved "+off)},
			3: {round("approved", "Approved "+onMain)},
		}[id]
		submit := map[int64]string{1: "Head " + onMain, 2: "ready for review", 3: "Head " + off}[id]
		return map[string]any{"workflow": map[string]any{"completion_review": map[string]any{"message": submit}, "review_rounds": rounds}}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	var ids []string
	for _, r := range got {
		ids = append(ids, fmt.Sprintf("%d:%s:%s", r.ID, r.SHA, r.Why))
	}
	assert.Equal(t, []string{"1:" + off + ":not on main", "2:" + off + ":not on main"}, ids, "the approved head decides; a rejected round's SHA never does")
}

// #18191: only a code submit that went through review is a candidate (a task with no reviewers has no commit to find, and 536 of them buried the real ones), a task the board records as landed (mark-landed)
// is not listed whatever the ref holds, and a title is printed as one clean line in the text and the JSON.
func TestUnlandedListsOnlyReviewedSubmitsSkipsMarkedLandedAndCleansTitles(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "never landed")
	off := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "main")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	reviewers := []any{"Security Reviewer"}
	tasks := []map[string]any{
		{"id": 1.0, "status": "completed", "outcome": "success", "completed_at": day, "title": "reviewed, not on main", "reviewers": reviewers},
		{"id": 2.0, "status": "completed", "outcome": "success", "completed_at": day, "title": "no reviewers: a plain task done with a message"},
		{"id": 3.0, "status": "completed", "outcome": "success", "completed_at": day, "title": "marked landed on the board", "reviewers": reviewers},
		{"id": 4.0, "status": "completed", "outcome": "success", "completed_at": day, "title": "evil \x1b]0;pwned\x07title\nsecond line", "reviewers": reviewers},
	}
	read := []int64{}
	detail := func(id int64) (map[string]any, error) {
		read = append(read, id)
		wf := map[string]any{"completion_review": map[string]any{"message": "Head " + off, "reason": "review pending"}}
		if id == 3 {
			wf["artifacts"] = []any{map[string]any{"kind": "landed-commit", "landed_at": day}}
		}
		return map[string]any{"workflow": wf}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	var ids []int64
	for _, r := range got {
		ids = append(ids, r.ID)
	}
	assert.Equal(t, []int64{1, 4}, ids, "the unreviewed task and the one marked landed are not listed")
	assert.NotContains(t, read, int64(2), "an unreviewed task is not even read")
	assert.Equal(t, "evil title second line", got[1].Title, "a title is one clean line")
}

// #18191 (the Orchestrator's fold-in from #18373): only "(#N)" at the end of a subject names a task, a Revert never does, and the counts say what the list leaves out.
func TestUnlandedNamesATaskOnlyByAnEndingNumberAndCountsWhatItSkips(t *testing.T) {
	for line, want := range map[string]int64{
		"Merge 0123abc4567 into the trial (#304)": 304,
		"Fix the thing (#17452)":                  17452,
		"Fix the thing (#17452)  ":                17452,
		"follows #17452 in spirit":                0,
		"Fix the thing (#17452) and more":         0,
		"Revert \"Fix the thing (#17452)\"":       0,
		"revert: Fix the thing (#17452)":          0,
		"no number":                               0,
	} {
		n, ok := namedInSubject(line)
		assert.Equal(t, want != 0, ok, line)
		assert.Equal(t, want, n, line)
	}

	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "never landed")
	off := shortHead(t, repo)
	gitIn(t, repo, "checkout", "-q", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "Merge a head into the trial (#402)")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "Revert \"Merge a head into the trial (#403)\"")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	rv := []any{"Security Reviewer"}
	tasks := []map[string]any{
		{"id": 401.0, "status": "completed", "outcome": "success", "reviewers": rv, "completed_at": day, "title": "marked landed"},
		{"id": 402.0, "status": "completed", "outcome": "success", "reviewers": rv, "completed_at": day, "title": "named on the ref"},
		{"id": 403.0, "status": "completed", "outcome": "success", "reviewers": rv, "completed_at": day, "title": "its only mention on the ref is a revert"},
	}
	detail := func(id int64) (map[string]any, error) {
		wf := map[string]any{"completion_review": map[string]any{"message": "Head " + off, "reason": "review pending"}}
		if id == 401 {
			wf["artifacts"] = []any{map[string]any{"landed_at": day}}
		}
		return map[string]any{"workflow": wf}, nil
	}
	got, counts, err := findUnlandedCounted(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, int64(403), got[0].ID, "a revert does not land it")
	assert.Equal(t, unlandCounts{Checked: 3, MarkedLanded: 1, Named: 1}, counts)
}

// A head named in the words people write (#19603): in backticks, after "revision" or "@", from the structured fields the board keeps when the text names none.
func TestHeadSHAIsFoundInTheWordsSubmitsUse(t *testing.T) {
	assert.Equal(t, "d5eec7c3d3", headSHAFromText("in review at `d5eec7c3d3`, stacked on `25fe1fd9eb`"), "backticks around the commit")
	assert.Equal(t, "75d04da523", headSHAFromText("Ready for batch: correct author revision 75d04da523, all checks pass"))
	assert.Equal(t, "abc1234def", headSHAFromText("fix-19570 @ abc1234def"))
	assert.Equal(t, "abc1234def", headSHAFromText("pushed abc1234def"))
	assert.Equal(t, "", headSHAFromText("stacked on `25fe1fd9eb`"), "a base in backticks is still no head")
}

func TestUnlandedTakesTheHeadFromTheBoardsFieldsWhenTheTextNamesNone(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	gitIn(t, repo, "checkout", "-q", "-b", "topic")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "topic work")
	off := gitIn(t, repo, "rev-parse", "HEAD")
	gitIn(t, repo, "checkout", "-q", "main")
	main := gitIn(t, repo, "rev-parse", "HEAD")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	mk := func(id float64, title string) map[string]any {
		return map[string]any{"id": id, "status": "completed", "outcome": "success", "reviewers": []any{"QA"}, "completed_at": day, "title": title}
	}
	tasks := []map[string]any{mk(1, "head only in an artifact revision"), mk(2, "head only in submitted_head"), mk(3, "artifact revision beats submitted_head"), mk(4, "nothing anywhere")}
	detail := func(id int64) (map[string]any, error) {
		cr := map[string]any{"reason": "Ready for batch, all checks pass"}
		wf := map[string]any{"completion_review": cr}
		switch id {
		case 1:
			cr["artifacts"] = []any{map[string]any{"name": "patch", "revision": off}}
		case 2:
			wf["submitted_head"] = off
		case 3:
			cr["artifacts"] = []any{map[string]any{"name": "patch", "revision": off}}
			wf["submitted_head"] = main // a landed commit must not hide the artifact's head
		}
		return map[string]any{"workflow": wf}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	var ids []string
	for _, r := range got {
		ids = append(ids, fmt.Sprintf("%d:%s", r.ID, r.Why))
	}
	assert.Equal(t, []string{"1:not on main", "2:not on main", "3:not on main", "4:no head SHA recorded"}, ids)
	assert.Equal(t, off, got[0].SHA)
}

// A head no remote branch holds was never pushed (#19603): 7 approved heads had no remote branch. The check only speaks when the repository has remote branches at all.
func TestUnlandedFlagsAHeadNoRemoteBranchContains(t *testing.T) {
	bare := t.TempDir()
	gitIn(t, bare, "init", "-q", "--bare", "-b", "main")
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	gitIn(t, repo, "remote", "add", "origin", bare)
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "first")
	gitIn(t, repo, "push", "-q", "origin", "main")
	gitIn(t, repo, "checkout", "-q", "-b", "pushed")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "pushed work")
	pushed := gitIn(t, repo, "rev-parse", "HEAD")
	gitIn(t, repo, "push", "-q", "origin", "pushed")
	gitIn(t, repo, "checkout", "-q", "-b", "local")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "local work")
	local := gitIn(t, repo, "rev-parse", "HEAD")
	gitIn(t, repo, "checkout", "-q", "main")
	now := time.Now().UTC()
	day := now.Add(-24 * time.Hour).Format(time.RFC3339)
	tasks := []map[string]any{
		{"id": 1.0, "status": "completed", "outcome": "success", "reviewers": []any{"QA"}, "completed_at": day, "title": "on a remote branch"},
		{"id": 2.0, "status": "completed", "outcome": "success", "reviewers": []any{"QA"}, "completed_at": day, "title": "only on this computer"},
	}
	heads := map[int64]string{1: pushed, 2: local}
	detail := func(id int64) (map[string]any, error) {
		return map[string]any{"workflow": map[string]any{"completion_review": map[string]any{"message": "Head " + heads[id]}}}, nil
	}
	got, err := findUnlanded(tasks, now.Add(-7*24*time.Hour), "main", detail, gitChecks(repo, "main"))
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.Equal(t, "not on main", got[0].Why)
	assert.Contains(t, got[1].Why, "no remote branch", "the head that was never pushed says so")
}

// A head is a pick only when every one of its commits has its patch on the ref (#19603): one commit that is not there keeps the whole head unlanded, and a head with no patch is no pick.
func TestUnlandedPickNeedsEveryPatchOnTheRef(t *testing.T) {
	repo := t.TempDir()
	gitIn(t, repo, "init", "-q", "-b", "main")
	write := func(name string) {
		require.NoError(t, os.WriteFile(repo+"/"+name, []byte(name+"\n"), 0o644))
		gitIn(t, repo, "add", "-A")
		gitIn(t, repo, "commit", "-q", "-m", name)
	}
	write("base.txt")
	gitIn(t, repo, "checkout", "-q", "-b", "two", "main")
	write("a.txt")
	write("b.txt")
	two := gitIn(t, repo, "rev-parse", "HEAD")
	gitIn(t, repo, "checkout", "-q", "main")
	write("moved.txt")
	gitIn(t, repo, "cherry-pick", "two~1") // only a.txt's commit comes over
	c := gitChecks(repo, "main")
	assert.False(t, c.Picked(two), "b.txt's patch is not on main")
	gitIn(t, repo, "cherry-pick", "two")
	assert.True(t, c.Picked(two), "both patches are on main under other SHAs")
	assert.False(t, c.Picked(gitIn(t, repo, "rev-parse", "main")), "a head that is the ref has no patch to pick")
}
