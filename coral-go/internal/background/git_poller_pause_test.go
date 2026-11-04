package background

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/gitguard"
)

func storedNames(t *testing.T, p *GitPoller, sid string) int {
	t.Helper()
	files, _, err := p.store.GetChangedFiles(context.Background(), "", &sid, "branch_point")
	require.NoError(t, err)
	return len(files)
}

// A folder whose git pass is slow is paused (#13079): its last list stays, the next pass does not run git for it, and turning live updates back on makes the next pass current again.
func TestGitPollPausesASlowFolderAndKeepsItsList(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	old := gitguard.SlowPass
	t.Cleanup(func() { gitguard.SlowPass = old })
	dir := repoWithTracked(t, 1)
	for i := 0; i < 5; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("a-%d.txt", i)), []byte("x\n"), 0o644))
	}
	sid := "s-pause"
	p, _ := newPollerFor(t, dir, sid)
	gitguard.SlowPass = time.Nanosecond // every pass is slow: a stand-in for a 35,000-file repository
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 5, storedNames(t, p, sid), "the slow pass itself is stored")
	pz, paused := gitguard.Get(dir)
	require.True(t, paused, "a slow pass pauses the folder")
	require.Equal(t, 5, pz.Changes)

	for i := 5; i < 9; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("a-%d.txt", i)), []byte("x\n"), 0o644))
	}
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 5, storedNames(t, p, sid), "a paused folder is not polled: the list stays as it was")

	gitguard.Resume(dir)
	gitguard.SlowPass = time.Hour
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 9, storedNames(t, p, sid), "live updates back on: the list is current")
	_, paused = gitguard.Get(dir)
	require.False(t, paused)
}

// A pass that times out keeps the last good list (it was cleared to empty before: the panel flickered to nothing) and pauses the folder.
func TestGitPollTimeoutKeepsTheLastListAndPauses(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	dir := repoWithTracked(t, 1)
	for i := 0; i < 4; i++ {
		require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("b-%d.txt", i)), []byte("x\n"), 0o644))
	}
	sid := "s-timeout"
	p, _ := newPollerFor(t, dir, sid)
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 4, storedNames(t, p, sid))
	old := gitQueryTimeout
	t.Cleanup(func() { gitQueryTimeout = old })
	gitQueryTimeout = time.Nanosecond // git cannot answer in time
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 4, storedNames(t, p, sid), "the last good list is kept, not cleared")
	_, paused := gitguard.Get(dir)
	require.True(t, paused, "a timed-out folder is paused")
}
