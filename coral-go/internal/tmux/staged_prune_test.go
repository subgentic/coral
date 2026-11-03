//go:build !windows

package tmux

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// five copies, oldest first (c1 is the oldest), with the mtimes set by hand
func pruneRig(t *testing.T) (dir string, c []string) {
	t.Helper()
	dir = t.TempDir()
	base := time.Now().Add(time.Hour) // all newer than anything else made in the folder during a test
	for i, n := range []string{"tmux-0001", "tmux-0002", "tmux-0003", "tmux-0004", "tmux-0005"} {
		p := filepath.Join(dir, n)
		require.NoError(t, os.WriteFile(p, []byte(n), 0o700))
		require.NoError(t, os.Chtimes(p, base.Add(time.Duration(i)*time.Hour), base.Add(time.Duration(i)*time.Hour)))
		c = append(c, p)
	}
	return dir, c
}

func fakeRunning(t *testing.T, paths ...string) {
	t.Helper()
	prev := runningExecutables
	runningExecutables = func() (map[string]bool, bool) {
		m := map[string]bool{}
		for _, p := range paths {
			m[p] = true
		}
		return m, true
	}
	t.Cleanup(func() { runningExecutables = prev })
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func TestPruningKeepsTheNewestTwoAndTheOneInUseAndAnyARunningServerUses(t *testing.T) {
	dir, c := pruneRig(t)
	fakeRunning(t, c[1])   // a live tmux server was started from the second-oldest copy
	pruneStaged(dir, c[0]) // and the one in use now is the oldest

	assert.True(t, exists(c[4]) && exists(c[3]), "the newest two stay")
	assert.True(t, exists(c[0]), "the copy in use now stays, though it is the oldest")
	assert.True(t, exists(c[1]), "a copy a running tmux server was started from is never removed")
	assert.False(t, exists(c[2]), "an old copy nothing uses is removed")
}

func TestNothingIsRemovedWhenTheRunningProcessesCannotBeListed(t *testing.T) {
	dir, c := pruneRig(t)
	prev := runningExecutables
	runningExecutables = func() (map[string]bool, bool) { return nil, false }
	t.Cleanup(func() { runningExecutables = prev })
	pruneStaged(dir, c[4])
	for _, p := range c {
		assert.True(t, exists(p), "%s: when it cannot be known whether a server runs from it, it stays", p)
	}
}

func TestPruningLeavesLinksFoldersAndOtherFilesAlone(t *testing.T) {
	dir, c := pruneRig(t)
	fakeRunning(t)
	outside := filepath.Join(t.TempDir(), "keep-me")
	require.NoError(t, os.WriteFile(outside, []byte("x"), 0o600))
	link := filepath.Join(dir, "tmux-link")
	require.NoError(t, os.Symlink(outside, link))
	require.NoError(t, os.Mkdir(filepath.Join(dir, "tmux-folder"), 0o700))
	other := filepath.Join(dir, "notes.txt")
	require.NoError(t, os.WriteFile(other, []byte("n"), 0o600))
	old := time.Now().Add(-100 * time.Hour)
	require.NoError(t, os.Chtimes(other, old, old))

	pruneStaged(dir, c[4])

	assert.True(t, exists(outside), "a link is never followed")
	assert.True(t, exists(link) && exists(filepath.Join(dir, "tmux-folder")) && exists(other))
	assert.False(t, exists(c[0]) || exists(c[1]) || exists(c[2]), "the old copies went")
}

func TestStagingAnotherCopyPrunesTheOldOnesButNotAServersFile(t *testing.T) {
	data := t.TempDir()
	dir := filepath.Join(data, stagedDir)
	require.NoError(t, os.MkdirAll(dir, 0o700))
	old := filepath.Join(dir, "tmux-1111111111111111")
	older := filepath.Join(dir, "tmux-2222222222222222")
	oldest := filepath.Join(dir, "tmux-3333333333333333")
	for i, p := range []string{old, older, oldest} {
		require.NoError(t, os.WriteFile(p, []byte("x"), 0o700))
		ts := time.Now().Add(-time.Duration(i+1) * 24 * time.Hour)
		require.NoError(t, os.Chtimes(p, ts, ts))
	}
	fakeRunning(t, oldest)

	got := stageTmux(data, writeTmux(t, t.TempDir(), "echo new"), "")
	require.NotEmpty(t, got)

	assert.True(t, exists(got), "the new copy")
	assert.True(t, exists(old), "newest of the old: kept with the new one (the newest two)")
	assert.False(t, exists(older), "older and unused: removed")
	assert.True(t, exists(oldest), "oldest, but a running server's: never removed")
}

// The real listing finds a live process by its executable's path: this test program itself.
func TestTheRealListingOfRunningProgramsFindsThisOne(t *testing.T) {
	exe, err := os.Executable()
	require.NoError(t, err)
	exe, err = filepath.EvalSymlinks(exe)
	require.NoError(t, err)
	got, ok := runningExecutables()
	require.True(t, ok)
	found := got[exe]
	if !found {
		for p := range got { // the path may be spelled through a link (a temp folder under /var)
			if r, err := filepath.EvalSymlinks(p); err == nil && r == exe {
				found = true
			}
		}
	}
	assert.True(t, found, "the process listing names this test's own executable %s", exe)
}

// A running process names its executable through a link (the data folder under a linked folder, /var for /private/var): the same file in another spelling is still in use (Security's SHOULD on #12624).
func TestACopyARunningServerUsesIsKeptWhenThePathsAreSpelledThroughALink(t *testing.T) {
	dir, c := pruneRig(t)
	via := filepath.Join(t.TempDir(), "via")
	require.NoError(t, os.Symlink(dir, via))
	fakeRunning(t, filepath.Join(via, filepath.Base(c[1]))) // the process list spells it through the link; the folder is pruned by its real name

	pruneStaged(dir, c[4])

	assert.True(t, exists(c[1]), "the same file through a link is the file a server runs from")
	assert.False(t, exists(c[2]), "an unused old one still goes")

	// And the other way round: the folder reached through the link, the process listed by the real path.
	dir2, c2 := pruneRig(t)
	via2 := filepath.Join(t.TempDir(), "via2")
	require.NoError(t, os.Symlink(dir2, via2))
	fakeRunning(t, c2[0])
	pruneStaged(via2, filepath.Join(via2, filepath.Base(c2[4])))
	assert.True(t, exists(c2[0]))
	assert.False(t, exists(c2[1]))
}
