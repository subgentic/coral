package background

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #11704: two agents launched in ONE folder that then move into two worktrees of its repository are two different places: the poller reads the folder, branch, commit and changed files of where each is now, and
// an agent with no known place, or one that moved somewhere that is not this repository's, keeps the folder it was launched in.
func TestGitPollerFollowsAnAgentIntoItsOwnWorktree(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	holder := t.TempDir()
	wtA, wtB := filepath.Join(holder, "wt-a"), filepath.Join(holder, "wt-b")
	runGit(t, repo, "worktree", "add", "-q", "-b", "feat-a", wtA)
	runGit(t, repo, "worktree", "add", "-q", "-b", "feat-b", wtB)
	outside := t.TempDir() // a folder that is not this repository's

	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	p := NewGitPoller(store.NewGitStore(db), nil, time.Minute)
	p.discoverFn = func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{
			{AgentName: "coral-go", AgentType: "claude", SessionID: "s-a", WorkingDirectory: repo},
			{AgentName: "coral-go", AgentType: "claude", SessionID: "s-b", WorkingDirectory: repo},
			{AgentName: "coral-go", AgentType: "claude", SessionID: "s-c", WorkingDirectory: repo},
			{AgentName: "coral-go", AgentType: "claude", SessionID: "s-d", WorkingDirectory: repo},
		}, nil
	}
	where := map[string]string{"s-a": wtA, "s-b": wtB, "s-c": outside, "s-d": ""}
	p.SetCurrentDirFn(NewCurrentDirReader(func(sessionID, launch, agentType string) string { return where[sessionID] }))
	require.NoError(t, p.PollOnce(context.Background()))

	dirOf := func(sid string) (string, string) {
		var row struct {
			Dir    string `db:"working_directory"`
			Branch string `db:"branch"`
		}
		require.NoError(t, db.Get(&row, `SELECT working_directory, branch FROM git_snapshots WHERE session_id = ?`, sid))
		return row.Dir, row.Branch
	}
	real := func(p string) string { r, err := filepath.EvalSymlinks(p); require.NoError(t, err); return r } // the poller stores the checkout's real root
	dirA, brA := dirOf("s-a")
	dirB, brB := dirOf("s-b")
	assert.Equal(t, real(wtA), dirA, "agent A is where it moved: its own worktree")
	assert.Equal(t, "feat-a", brA)
	assert.Equal(t, real(wtB), dirB)
	assert.Equal(t, "feat-b", brB, "and B is somewhere else, not the same line")
	dirC, brC := dirOf("s-c")
	assert.Equal(t, real(repo), dirC, "a folder that is not this repository's is not followed")
	assert.Equal(t, "main", brC)
	dirD, _ := dirOf("s-d")
	assert.Equal(t, real(repo), dirD, "an agent with no known place keeps its launch folder")
}

// #11739 (Security's INFO on #11704): a folder approved as the agent's own worktree and then swapped for a link to another repository is not read: the poller checks again at every poll and reads the real path, so the
// next poll finds it is not this repository's and reads the launch folder.
func TestAFolderSwappedForALinkToAnotherRepoIsNotReadAtTheNextPoll(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-q", "-b", "main")
	runGit(t, repo, "commit", "-q", "--allow-empty", "-m", "base")
	wt := filepath.Join(t.TempDir(), "wt-a")
	runGit(t, repo, "worktree", "add", "-q", "-b", "feat-a", wt)
	other := t.TempDir()
	runGit(t, other, "init", "-q", "-b", "elsewhere")
	runGit(t, other, "commit", "-q", "--allow-empty", "-m", "someone else's repository")

	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "sessions.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	p := NewGitPoller(store.NewGitStore(db), nil, time.Minute)
	p.discoverFn = func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentName: "coral-go", AgentType: "claude", SessionID: "s-a", WorkingDirectory: repo}}, nil
	}
	p.SetCurrentDirFn(NewCurrentDirReader(func(string, string, string) string { return wt }))
	branch := func() string {
		var b string
		require.NoError(t, db.Get(&b, `SELECT branch FROM git_snapshots WHERE session_id = 's-a' ORDER BY id DESC LIMIT 1`))
		return b
	}
	require.NoError(t, p.PollOnce(context.Background()))
	assert.Equal(t, "feat-a", branch(), "approved: its own worktree")

	require.NoError(t, os.RemoveAll(wt))
	require.NoError(t, os.Symlink(other, wt)) // the folder is now a link to another repository
	require.NoError(t, p.PollOnce(context.Background()))
	assert.Equal(t, "main", branch(), "the swap is not read: the launch folder is")

	// the finder for what the person sees keeps its verdict for 30 s: it is text, never read from
	seen := NewCurrentDirFinder(func(string, string, string) string { return wt })
	assert.Equal(t, "", seen(context.Background(), AgentInfo{AgentType: "claude", SessionID: "s-a", WorkingDirectory: repo}), "a link to another repository is not a worktree of this one")
}
