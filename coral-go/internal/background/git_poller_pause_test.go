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

// A folder whose git passes are slow is paused (#13079): after two in a row, its last list stays, the next passes do not run git for it until the retry is due, and a fast retry turns live updates back on.
func TestGitPollPausesASlowFolderAfterTwoPassesAndRetriesLater(t *testing.T) {
	gitguard.Reset()
	t.Cleanup(gitguard.Reset)
	oldSlow, oldRetry := gitguard.SlowPass, gitguard.RetryAfter
	t.Cleanup(func() { gitguard.SlowPass, gitguard.RetryAfter = oldSlow, oldRetry })
	dir := repoWithTracked(t, 1)
	add := func(from, to int) {
		for i := from; i < to; i++ {
			require.NoError(t, os.WriteFile(filepath.Join(dir, fmt.Sprintf("a-%d.txt", i)), []byte("x\n"), 0o644))
		}
	}
	add(0, 5)
	sid := "s-pause"
	p, _ := newPollerFor(t, dir, sid)
	gitguard.SlowPass = time.Nanosecond // every pass is slow: a stand-in for a 35,000-file repository
	gitguard.RetryAfter = time.Hour
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 5, storedNames(t, p, sid), "the first slow pass is stored")
	_, paused := gitguard.Get(dir)
	require.False(t, paused, "one slow pass does not pause the folder")

	add(5, 9)
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 9, storedNames(t, p, sid), "the second is stored too")
	pz, paused := gitguard.Get(dir)
	require.True(t, paused, "two slow passes in a row pause it")
	require.Equal(t, 9, pz.Changes)

	add(9, 12)
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 9, storedNames(t, p, sid), "a paused folder is not polled before its retry is due: the list stays")

	gitguard.RetryAfter = 0 // the retry is due
	gitguard.SlowPass = time.Hour
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 12, storedNames(t, p, sid), "the retry ran, and was current")
	_, paused = gitguard.Get(dir)
	require.False(t, paused, "a fast retry turns live updates back on")
}

// Timeouts are slow passes too: two pause the folder, and the last good list is kept, not cleared to empty.
func TestGitPollTimeoutsKeepTheLastListAndPauseAfterTwo(t *testing.T) {
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
	require.False(t, paused, "one timeout is a strike")
	require.NoError(t, p.PollOnce(context.Background()))
	require.Equal(t, 4, storedNames(t, p, sid))
	_, paused = gitguard.Get(dir)
	require.True(t, paused, "two timeouts in a row pause the folder")
}
