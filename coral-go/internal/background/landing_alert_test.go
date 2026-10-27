package background

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/gitutil"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// The landing alert (#8942, goal #80): a branch that has stood still for the team's wait while tasks were completed since is a line of the orchestrator's check, once per wait.

type landingRig struct {
	*checkHarness
	w      *LandingWatch
	hash   string
	moved  time.Time // the tip's committer time
	byRoot map[string][]AgentInfo
}

func newLandingRig(t *testing.T) *landingRig {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	r := &landingRig{checkHarness: h, hash: "aaaaaaaaaaaaaaaaaaaa", byRoot: map[string][]AgentInfo{}}
	r.moved = h.now.Add(-3 * time.Hour)
	r.w = NewLandingWatch(h.s)
	r.w.tip = func(_ context.Context, root, branch string) (string, string, time.Time, error) {
		if branch != "main" {
			return "", "", time.Time{}, errors.New("no such branch")
		}
		return "/repo/.git", r.hash, r.moved, nil
	}
	h.m.SetLandingWatch(r.w)
	r.byRoot["/repo"] = []AgentInfo{h.agents[1]}
	h.settings(func(hs *board.HealthSettings) {
		hs.On, hs.Landing = true, board.HealthLanding{On: true, Branch: "main", WaitMin: 120}
	})
	return r
}

func (r *landingRig) finish(title string) {
	r.t.Helper()
	_, err := r.s.CreateTask(context.Background(), "team", title, "", "medium", "Orchestrator", "Dev")
	require.NoError(r.t, err)
	task, err := r.s.ClaimTask(context.Background(), "team", "Dev")
	require.NoError(r.t, err)
	_, err = r.s.CompleteTask(context.Background(), "team", task.ID, "Dev", nil)
	require.NoError(r.t, err)
}

func (r *landingRig) check() string {
	r.w.Observe(context.Background(), r.byRoot)
	return r.next()
}

func TestLandingAlertIsOneLineOncePerWait(t *testing.T) {
	r := newLandingRig(t)
	r.finish("work")
	first := r.check()
	assert.Contains(t, first, "Board: main has not moved for 3 h", "the tip is 3 h old, the wait 2 h")
	assert.Contains(t, first, "1 task was completed since it did: not landed")
	assert.NotContains(t, r.check(), "has not moved", "said once, not at the next check")
	// Still standing after a further wait: said again, once.
	r.now = r.now.Add(2 * time.Hour)
	again := r.check()
	assert.Contains(t, again, "main has not moved for 5 h")
	assert.NotContains(t, r.check(), "has not moved")
}

func TestLandingAlertNeedsFinishedTasksAndTheWait(t *testing.T) {
	r := newLandingRig(t)
	assert.NotContains(t, r.check(), "has not moved", "no task was completed since the branch moved")
	r.finish("work")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.WaitMin = 600 })
	assert.NotContains(t, r.check(), "has not moved", "the tip is 3 h old, the wait 10 h")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.WaitMin = 120 })
	assert.Contains(t, r.check(), "has not moved")
}

func TestLandingAlertForgetsWhatLandedBeforeTheBranchMoved(t *testing.T) {
	r := newLandingRig(t)
	r.finish("work")
	r.moved = r.now.Add(time.Minute) // the branch moved after the task was completed
	assert.NotContains(t, r.check(), "has not moved")
}

func TestLandingAlertResetsWhenTheBranchMoves(t *testing.T) {
	r := newLandingRig(t)
	assert.NotContains(t, r.check(), "has not moved") // first sight, 3 h old, nothing finished
	r.finish("work")
	r.hash = "bbbbbbbbbbbbbbbbbbbb" // it moved: the wait starts again from when Coral saw it
	assert.NotContains(t, r.check(), "has not moved", "the work before the move is landed")
	r.w.mu.Lock()
	for k, st := range r.w.seen {
		assert.Equal(t, r.hash, st.hash)
		assert.WithinDuration(t, r.now, st.moved, time.Minute, "the wait runs from the move Coral saw")
		st.moved = r.now.Add(-3 * time.Hour) // three hours pass
		r.w.seen[k] = st
	}
	r.w.mu.Unlock()
	r.finish("more")
	assert.Contains(t, r.check(), "has not moved")
}

func TestLandingAlertIsOffByDefaultAndFollowsItsBranch(t *testing.T) {
	assert.False(t, board.DefaultHealthSettings().Landing.On)
	assert.Equal(t, board.HealthLanding{Branch: "main", WaitMin: 120}, board.DefaultHealthSettings().Landing)
	r := newLandingRig(t)
	r.finish("work")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.Branch = "release" }) // no such local branch
	assert.NotContains(t, r.check(), "has not moved")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.On, hs.Landing.Branch = false, "main" })
	assert.NotContains(t, r.check(), "has not moved")
}

func TestLandingAlertNudgesAnotherMemberOnce(t *testing.T) {
	r := newLandingRig(t)
	r.finish("work")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.Nudge = "Dev" })
	assert.Contains(t, r.check(), "has not moved")
	r.mu.Lock()
	got := append([]string(nil), r.sent["Dev"]...)
	r.mu.Unlock()
	require.Len(t, got, 1)
	assert.Contains(t, got[0], "main has not moved for 3 h")
	r.check()
	r.mu.Lock()
	assert.Len(t, r.sent["Dev"], 1, "told once")
	r.mu.Unlock()
}

func TestLandingAlertDoesNotNudgeTheCheckRecipientTwice(t *testing.T) {
	r := newLandingRig(t)
	r.finish("work")
	r.settings(func(hs *board.HealthSettings) { hs.Landing.Nudge = "Orchestrator" })
	assert.Contains(t, r.check(), "has not moved")
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, text := range r.sent["Orchestrator"] {
		assert.False(t, strings.HasPrefix(text, "[Coral health] main"), "the line is in the check, not also a message of its own")
	}
}

func TestGitTipReadsTheLocalBranchAndSharesWorktreeRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(d string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main"}, args...)...)
		cmd.Dir = d
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	run(dir, "init", "-q")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "f"), []byte("x"), 0o600))
	run(dir, "add", "f")
	run(dir, "commit", "-q", "-m", "one")
	wt := filepath.Join(t.TempDir(), "wt")
	run(dir, "worktree", "add", "-q", "-b", "side", wt)

	repoA, hashA, when, err := gitTip(context.Background(), dir, "main")
	require.NoError(t, err)
	repoB, hashB, _, err := gitTip(context.Background(), wt, "main")
	require.NoError(t, err)
	assert.Equal(t, repoA, repoB, "a worktree shares its repository")
	assert.Equal(t, hashA, hashB)
	assert.Len(t, hashA, 40)
	assert.WithinDuration(t, time.Now(), when, time.Minute)
	_, _, _, err = gitTip(context.Background(), dir, "nope")
	assert.Error(t, err)
}

// The git poller hands the watch each team's repositories every pass, and a member's repository is the one the alert reads.
func TestGitPollerFeedsTheLandingWatch(t *testing.T) {
	r := newLandingRig(t)
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	require.NoError(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("one\n"), 0o600))
	runGit(t, repo, "add", ".")
	runGit(t, repo, "commit", "-q", "-m", "base")
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	p := NewGitPoller(store.NewGitStore(db), nil, time.Minute)
	p.SetLandingWatch(r.w)
	dev := r.agents[1]
	dev.WorkingDirectory = repo
	stranger := AgentInfo{AgentName: "x", AgentType: "claude", SessionID: "99999999-0000-0000-0000-000000000000", WorkingDirectory: t.TempDir()}
	p.discoverFn = func(context.Context) ([]AgentInfo, error) { return []AgentInfo{dev, stranger}, nil }
	require.NoError(t, p.PollOnce(context.Background()))
	r.w.mu.Lock()
	defer r.w.mu.Unlock()
	require.Len(t, r.w.roots["team"], 1)
	assert.Equal(t, gitutil.ResolveGitRoot(context.Background(), repo), r.w.roots["team"][0])
}

// The release alert (#8948): the branch has been past the newest release tag it contains for longer than the wait, with tasks completed since the tag.
func (r *landingRig) releaseState(tag string, commits int, tagAgo, aheadAgo time.Duration) {
	r.w.release = func(_ context.Context, _, branch, pattern string) (releaseState, error) {
		if branch != "main" || pattern != "v*" {
			return releaseState{}, errors.New("no such branch or tag")
		}
		return releaseState{Repo: "/repo/.git", Tag: tag, TagTime: r.now.Add(-tagAgo), Commits: commits, AheadSince: r.now.Add(-aheadAgo)}, nil
	}
}

func (r *landingRig) releaseOn() {
	r.settings(func(hs *board.HealthSettings) {
		hs.Landing.On = false
		hs.Release = board.HealthRelease{On: true, Branch: "main", TagPattern: "v*", WaitMin: 1440}
	})
}

func TestReleaseAlertIsOneLineOncePerWait(t *testing.T) {
	assert.False(t, board.DefaultHealthSettings().Release.On)
	assert.Equal(t, board.HealthRelease{Branch: "main", TagPattern: "v*", WaitMin: 1440}, board.DefaultHealthSettings().Release)
	r := newLandingRig(t)
	r.releaseOn()
	r.finish("work")
	r.releaseState("v2.0.0", 12, 40*time.Hour, 30*time.Hour)
	first := r.check()
	assert.Contains(t, first, "Board: main is 12 commits and 1 task past v2.0.0 for 30 h")
	assert.NotContains(t, r.check(), "past v2.0.0", "said once, not at the next check")
	r.releaseState("v2.0.0", 15, 90*time.Hour, 80*time.Hour) // a further wait (and then some) later
	assert.Contains(t, r.check(), "main is 15 commits and 1 task past v2.0.0 for 80 h")
	assert.NotContains(t, r.check(), "past v2.0.0")
}

func TestReleaseAlertNeedsTheWaitFinishedTasksAndACommit(t *testing.T) {
	r := newLandingRig(t)
	r.releaseOn()
	r.releaseState("v2.0.0", 3, 40*time.Hour, 5*time.Hour) // ahead only 5 h
	r.finish("work")
	assert.NotContains(t, r.check(), "past v2.0.0", "the wait is 24 h")
	r.releaseState("v2.0.0", 3, 5*time.Minute, 30*time.Hour) // the tag is newer than every finished task
	assert.NotContains(t, r.check(), "past v2.0.0", "no task was completed since the tag")
	r.releaseState("v2.0.0", 0, 40*time.Hour, 30*time.Hour)
	assert.NotContains(t, r.check(), "past v2.0.0", "no commit past the tag")
	r.releaseState("", 0, 0, 0)
	assert.NotContains(t, r.check(), "past", "no tag at all")
}

func TestReleaseAlertIsOffUnlessSwitchedOnAndNudgesAnotherMemberOnce(t *testing.T) {
	r := newLandingRig(t)
	r.finish("work")
	r.releaseState("v2.0.0", 12, 40*time.Hour, 30*time.Hour)
	r.settings(func(hs *board.HealthSettings) { hs.Landing.On = false })
	assert.NotContains(t, r.check(), "past v2.0.0", "off")
	r.releaseOn()
	r.settings(func(hs *board.HealthSettings) { hs.Release.Nudge = "Dev" })
	assert.Contains(t, r.check(), "past v2.0.0")
	r.check()
	r.mu.Lock()
	defer r.mu.Unlock()
	require.Len(t, r.sent["Dev"], 1)
	assert.Contains(t, r.sent["Dev"][0], "main is 12 commits and 1 task past v2.0.0 for 30 h")
}

func TestGitReleaseReadsTheNewestMatchingTagTheBranchContains(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
	}
	commit := func(name string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(name), 0o600))
		run("add", name)
		run("commit", "-q", "-m", name)
	}
	run("init", "-q")
	commit("a")
	run("tag", "v1.0.0")
	commit("b")
	run("tag", "v2.0.0")
	run("tag", "nightly-1")
	commit("c")
	commit("d")
	run("checkout", "-q", "-b", "side", "v1.0.0")
	commit("e")
	run("tag", "v9.9.9") // newest, but on another branch: main does not contain it
	run("checkout", "-q", "main")

	st, err := gitRelease(context.Background(), dir, "main", "v*")
	require.NoError(t, err)
	assert.Equal(t, "v2.0.0", st.Tag, "the newest matching tag main contains")
	assert.Equal(t, 2, st.Commits)
	assert.False(t, st.AheadSince.IsZero())
	assert.WithinDuration(t, time.Now(), st.TagTime, time.Minute)
	none, err := gitRelease(context.Background(), dir, "main", "x*")
	require.NoError(t, err)
	assert.Equal(t, "", none.Tag)
	_, err = gitRelease(context.Background(), dir, "nobranch", "v*")
	assert.Error(t, err)
}
