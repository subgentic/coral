package background

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #14095 (the Operator: Tokens per commit showed no commits in 24 h while the repository got 455): agents work in worktrees and run `cd <worktree> && cmd`, so their transcripts never name a worktree and the poller saw only
// the shared checkout, parked on an old commit. The poller now also reads the worktrees of the session's repository that are the session's OWN (a path with an element that is the session id: the scratchpad folder is named with it),
// and records every new commit there since the last read, not only the tip. Nobody else's worktree is read, merge commits are not work, and a commit is recorded once.

type wtRig struct {
	repo, holder string
	db           *store.DB
	p            *GitPoller
	agents       []AgentInfo
}

func newWTRig(t *testing.T, sessions ...string) *wtRig {
	t.Helper()
	r := &wtRig{repo: t.TempDir(), holder: t.TempDir()}
	runGit(t, r.repo, "init", "-q", "-b", "main")
	runGit(t, r.repo, "commit", "-q", "--allow-empty", "-m", "base")
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	r.db = db
	r.p = NewGitPoller(store.NewGitStore(db), nil, time.Minute)
	for _, s := range sessions {
		r.agents = append(r.agents, AgentInfo{AgentName: "agent-" + s, AgentType: "claude", SessionID: s, WorkingDirectory: r.repo})
	}
	r.p.discoverFn = func(context.Context) ([]AgentInfo, error) { return r.agents, nil }
	return r
}

// worktree makes a worktree of the repo at holder/<owner>/<name>.
func (r *wtRig) worktree(t *testing.T, owner, name, branch string) string {
	t.Helper()
	dir := filepath.Join(r.holder, owner)
	require.NoError(t, os.MkdirAll(dir, 0o755))
	wt := filepath.Join(dir, name)
	runGit(t, r.repo, "worktree", "add", "-q", "-b", branch, wt)
	return wt
}

func (r *wtRig) commits(t *testing.T, session string) []string {
	t.Helper()
	var subjects []string
	require.NoError(t, r.db.Select(&subjects, `SELECT commit_subject FROM git_snapshots WHERE session_id = ? ORDER BY id`, session))
	return subjects
}

// madeInWorktrees are the subjects recorded from worktrees (the shared checkout's own tip, which every session launched there also sees, is the poller's old business).
func (r *wtRig) madeInWorktrees(t *testing.T, session string) []string {
	t.Helper()
	var subjects []string
	require.NoError(t, r.db.Select(&subjects, `SELECT commit_subject FROM git_snapshots WHERE session_id = ? AND is_worktree = 1 AND working_directory != ? ORDER BY id`, session, r.realRepo(t)))
	return subjects
}

func (r *wtRig) realRepo(t *testing.T) string {
	t.Helper()
	real, err := filepath.EvalSymlinks(r.repo)
	require.NoError(t, err)
	return real
}

func TestTheSessionsOwnWorktreeCommitsAreRecordedAllOfThemAndOnlyOnce(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wt := r.worktree(t, "sess-a", "wt-1", "feat-a")
	for _, m := range []string{"one", "two", "three"} { // three commits between two polls: a tip-only snapshot would see one
		runGit(t, wt, "commit", "-q", "--allow-empty", "-m", m)
	}
	require.NoError(t, r.p.PollOnce(context.Background()))
	got := r.commits(t, "sess-a")
	for _, m := range []string{"one", "two", "three"} {
		assert.Contains(t, got, m, "every commit of the worktree is seen")
	}
	n := len(got)
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Len(t, r.commits(t, "sess-a"), n, "a second poll with nothing new records nothing")
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "four")
	require.NoError(t, r.p.PollOnce(context.Background()))
	got = r.commits(t, "sess-a")
	assert.Len(t, got, n+1, "only the new commit is added")
	assert.Contains(t, got, "four")
	var dir string
	require.NoError(t, r.db.Get(&dir, `SELECT working_directory FROM git_snapshots WHERE session_id = 'sess-a' AND commit_subject = 'two'`))
	real, err := filepath.EvalSymlinks(wt)
	require.NoError(t, err)
	assert.Equal(t, real, dir, "the row says which worktree it came from")
}

func TestAnotherSessionsWorktreeIsNotReadAndAMergeCommitIsNotWork(t *testing.T) {
	r := newWTRig(t, "sess-a", "sess-b")
	wtA := r.worktree(t, "sess-a", "wt-a", "feat-a")
	wtB := r.worktree(t, "sess-b", "wt-b", "feat-b")
	runGit(t, wtA, "commit", "-q", "--allow-empty", "-m", "made by a")
	runGit(t, wtB, "commit", "-q", "--allow-empty", "-m", "made by b")
	runGit(t, wtA, "merge", "-q", "--no-ff", "-m", "Merge feat-b into feat-a", "feat-b") // a landing, not work
	require.NoError(t, r.p.PollOnce(context.Background()))
	a, b := r.commits(t, "sess-a"), r.commits(t, "sess-b")
	assert.Contains(t, a, "made by a")
	assert.NotContains(t, a, "made by b", "B's commit is B's, whoever merged it")
	assert.NotContains(t, a, "Merge feat-b into feat-a", "a merge commit is not recorded as work")
	assert.Contains(t, b, "made by b")
	assert.NotContains(t, b, "made by a", "A's worktree is not B's")
}

func TestAWorktreeOfNoSessionAndAFolderNotOfThisRepoAreNotRead(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wtNone := r.worktree(t, "somebody-else", "wt-x", "feat-x")
	runGit(t, wtNone, "commit", "-q", "--allow-empty", "-m", "nobody's")
	// a registered worktree of the session replaced by a link to another repository is not followed
	wtA := r.worktree(t, "sess-a", "wt-a", "feat-a")
	other := t.TempDir()
	runGit(t, other, "init", "-q", "-b", "elsewhere")
	runGit(t, other, "commit", "-q", "--allow-empty", "-m", "another repository")
	require.NoError(t, os.RemoveAll(wtA))
	if err := os.Symlink(other, wtA); err != nil {
		t.Skip("symbolic links are not available here: " + err.Error())
	}
	require.NoError(t, r.p.PollOnce(context.Background()))
	got := r.commits(t, "sess-a")
	assert.NotContains(t, got, "nobody's", "a worktree whose path does not name the session is not its own")
	assert.NotContains(t, got, "another repository", "a link to another repository is not read")
}

// the efficiency read counts a commit once: made in the worktree, then landed on main by a fast-forward (same hash), it is one commit with one session that saw it.
func TestACommitMadeInAWorktreeAndLandedOnMainIsOneCommit(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wt := r.worktree(t, "sess-a", "wt-a", "feat-a")
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "landed")
	require.NoError(t, r.p.PollOnce(context.Background()))
	runGit(t, r.repo, "merge", "-q", "--ff-only", "feat-a") // the Orchestrator lands it: the shared checkout now has the same commit
	require.NoError(t, r.p.PollOnce(context.Background()))
	cs, err := store.NewSessionStore(r.db).EfficiencyCommits(context.Background(), time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	require.NoError(t, err)
	n := 0
	for _, c := range cs {
		if len(c.Seen) > 0 && c.Hash != "" {
			n++
		}
	}
	landed := 0
	for _, c := range cs {
		for _, s := range c.Seen {
			if s.SessionID == "sess-a" {
				landed++
				break
			}
		}
	}
	assert.Equal(t, 2, landed, "base and landed: each once, not twice for being on two branches (2 commits, not 3)")
	_ = n
}

// the Operator's real case: the worktree is cut from a main that is far ahead of the shared checkout, and main is merged in and rebased onto later. None of the commits that brings in were made in the worktree.
func TestCommitsBroughtInByTheBaseAMergeOfMainOrARebaseAreNotTheSessions(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wt := r.worktree(t, "sess-a", "wt-a", "feat-a")
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "mine one")
	for _, m := range []string{"others 1", "others 2", "others 3"} { // landed by other people on main since
		runGit(t, r.repo, "commit", "-q", "--allow-empty", "-m", m)
	}
	runGit(t, wt, "merge", "-q", "--no-edit", "main") // main merged in: its commits and a merge commit
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "mine two")
	runGit(t, wt, "rebase", "-q", "main") // and rebased onto it
	require.NoError(t, r.p.PollOnce(context.Background()))
	got := r.madeInWorktrees(t, "sess-a")
	assert.Contains(t, got, "mine one")
	assert.Contains(t, got, "mine two")
	for _, o := range []string{"others 1", "others 2", "others 3"} {
		assert.NotContains(t, got, o, "a commit that came in with the base is not the session's")
	}
	for _, g := range got {
		assert.NotContains(t, g, "Merge", "a merge commit is not work")
	}
}

// Security's MUST on #14095: the commit ids come from a reflog, a file a program can write. Only a full hex id is ever handed to git; a field that looks like an option writes nothing and stops nothing.
func TestAReflogLineWithAnOptionInPlaceOfACommitIdIsNeverHandedToGit(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wt := r.worktree(t, "sess-a", "wt-a", "feat-a")
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "real one")
	target := filepath.Join(t.TempDir(), "injected.txt")
	// a line a hostile program appended to the worktree's reflog, in git's own layout, with an option where the new commit id goes
	common := filepath.Join(r.repo, ".git", "worktrees")
	entries, err := os.ReadDir(common)
	require.NoError(t, err)
	var reflog string
	for _, e := range entries {
		reflog = filepath.Join(common, e.Name(), "logs", "HEAD")
	}
	f, err := os.OpenFile(reflog, os.O_APPEND|os.O_WRONLY, 0o644)
	require.NoError(t, err)
	zero := "0000000000000000000000000000000000000000"
	_, err = f.WriteString(zero + " --output=" + target + " Evil <e@e> 1700000000 +0000\tcommit: evil\n")
	require.NoError(t, err)
	_, err = f.WriteString(zero + " -p Evil <e@e> 1700000000 +0000\tcommit: evil two\n")
	require.NoError(t, err)
	require.NoError(t, f.Close())
	require.NoError(t, r.p.PollOnce(context.Background()))
	_, statErr := os.Stat(target)
	assert.True(t, os.IsNotExist(statErr), "git was not given the option: it wrote no file")
	assert.Contains(t, r.madeInWorktrees(t, "sess-a"), "real one", "the real commit is still recorded")
	assert.Equal(t, []string{"a" + strings.Repeat("0", 39)}, madeHere(zero+" a"+strings.Repeat("0", 39)+" X <x@x> 1 +0000\tcommit: ok"), "a full id passes")
	assert.Empty(t, madeHere(zero+" --output=/tmp/x X <x@x> 1 +0000\tcommit: bad"), "an option does not")
	assert.Empty(t, madeHere(zero+" abc123 X <x@x> 1 +0000\tcommit: short"), "a short id does not")
}

// Timed on the real repository (1,081 registered worktrees, 400 of them some session's own): an idle pass is about 60 ms, but the first pass reads every worktree's commits and took 12 to 16 s. A pass must not hold the poller
// that long: at most worktreesPerPass worktrees are read for new commits in one pass, the rest wait for the next ones (each worktree's progress is its own), so the first read is spread over a few passes.
func TestTheFirstReadOfManyWorktreesIsSpreadOverPassesNotDoneInOne(t *testing.T) {
	old := worktreesPerPass
	worktreesPerPass = 2
	t.Cleanup(func() { worktreesPerPass = old })
	r := newWTRig(t, "sess-a")
	for i, name := range []string{"w1", "w2", "w3", "w4", "w5"} {
		wt := r.worktree(t, "sess-a", name, "feat-"+name)
		runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "commit in "+name)
		_ = i
	}
	count := func() int {
		n := 0
		for _, s := range r.madeInWorktrees(t, "sess-a") {
			if strings.HasPrefix(s, "commit in ") {
				n++
			}
		}
		return n
	}
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Equal(t, 2, count(), "the first pass reads two worktrees, not all five")
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Equal(t, 4, count())
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Equal(t, 5, count(), "and the third finishes: nothing is skipped for good")
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Equal(t, 5, count(), "and a pass with nothing new does no more")
}

// QA's surviving mutant on #14095 ('ownedBy always true'): the old link test pointed at a repository whose history lacks the commit ids, so git failed there whatever ownedBy said. These two point the session's registered
// worktree path at ANOTHER repository's checkout that HAS the commits (a clone of the repository, and a worktree of that clone), so only ownedBy stands between the reflog's ids and a read in the wrong folder.
func TestAWorktreePathThatIsALinkToAnotherRepositorysCheckoutIsNotRead(t *testing.T) {
	r := newWTRig(t, "sess-a")
	wt := r.worktree(t, "sess-a", "wt-a", "feat-a")
	runGit(t, wt, "commit", "-q", "--allow-empty", "-m", "made in the real worktree")
	clone := filepath.Join(t.TempDir(), "clone")
	runGit(t, t.TempDir(), "clone", "-q", r.repo, clone)
	runGit(t, clone, "fetch", "-q", "origin", "feat-a") // the clone has the commit objects: git log there would find them
	runGit(t, clone, "checkout", "-q", "-b", "mine", "FETCH_HEAD")
	cloneWT := filepath.Join(t.TempDir(), "clone-wt")
	runGit(t, clone, "worktree", "add", "-q", "-b", "other", cloneWT, "FETCH_HEAD")
	for name, target := range map[string]string{"a clone's checkout (its .git is a folder)": clone, "a worktree of the clone (its .git names the clone's registry)": cloneWT} {
		t.Run(name, func(t *testing.T) {
			r2 := newWTRig(t, "sess-a")
			wt2 := r2.worktree(t, "sess-a", "wt-a", "feat-a")
			runGit(t, wt2, "commit", "-q", "--allow-empty", "-m", "made in the real worktree")
			require.NoError(t, os.RemoveAll(wt2))
			if err := os.Symlink(target, wt2); err != nil {
				t.Skip("symbolic links are not available here: " + err.Error())
			}
			require.NoError(t, r2.p.PollOnce(context.Background()))
			assert.NotContains(t, r2.madeInWorktrees(t, "sess-a"), "made in the real worktree", "the commits of the reflog are not read in another repository's folder")
			var n int
			require.NoError(t, r2.db.Get(&n, `SELECT COUNT(*) FROM git_snapshots WHERE session_id = 'sess-a' AND working_directory = ?`, func() string { p, _ := filepath.EvalSymlinks(target); return p }()))
			assert.Zero(t, n, "nothing is recorded as made in the linked folder")
		})
	}
	// and the real worktree is still read when nothing is swapped
	require.NoError(t, r.p.PollOnce(context.Background()))
	assert.Contains(t, r.madeInWorktrees(t, "sess-a"), "made in the real worktree")
}
