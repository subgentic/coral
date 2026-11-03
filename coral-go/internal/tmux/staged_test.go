//go:build !windows

package tmux

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeTmux(t *testing.T, dir, body string) string {
	t.Helper()
	p := filepath.Join(dir, "tmux")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	return p
}

// A server started from the staged copy runs from a file an upgrade never replaces (#12598).
func TestAnUpgradedTmuxNeverOverwritesTheCopyAServerRunsFrom(t *testing.T) {
	data := t.TempDir()
	bundle := t.TempDir()
	old := stageTmux(data, writeTmux(t, bundle, "echo v1"), "/ti")
	require.NotEmpty(t, old)
	oldBytes, err := os.ReadFile(old)
	require.NoError(t, err)
	oldInfo, err := os.Stat(old)
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(data, stagedDir), filepath.Dir(old))
	assert.NotZero(t, oldInfo.Mode()&0o100, "executable")
	assert.Zero(t, oldInfo.Mode()&0o077, "owner only")

	// The same tmux again: the same file, not rewritten.
	again := stageTmux(data, writeTmux(t, bundle, "echo v1"), "/ti")
	assert.Equal(t, old, again)
	againInfo, _ := os.Stat(old)
	assert.True(t, os.SameFile(oldInfo, againInfo) && againInfo.ModTime().Equal(oldInfo.ModTime()), "an unchanged tmux is reused, not copied again")

	// The upgrade replaces the bundle's tmux in place: a new name, and the file a running server was started from is untouched.
	upgraded := stageTmux(data, writeTmux(t, bundle, "echo v2"), "/ti")
	require.NotEmpty(t, upgraded)
	assert.NotEqual(t, old, upgraded)
	nowBytes, err := os.ReadFile(old)
	require.NoError(t, err)
	assert.Equal(t, oldBytes, nowBytes, "the old copy is byte for byte what it was")
	entries, _ := os.ReadDir(filepath.Join(data, stagedDir))
	assert.Len(t, entries, 2, "both copies, and no half-written temporary file left behind")
}

func TestStagingRefusesALinkAndAWrongFileAndFallsBack(t *testing.T) {
	bundle := t.TempDir()
	bin := writeTmux(t, bundle, "echo v1")

	linked := t.TempDir()
	elsewhere := t.TempDir()
	require.NoError(t, os.Symlink(elsewhere, filepath.Join(linked, stagedDir)))
	assert.Empty(t, stageTmux(linked, bin, ""), "a folder that is a link is not written through")
	entries, _ := os.ReadDir(elsewhere)
	assert.Empty(t, entries)

	data := t.TempDir()
	good := stageTmux(data, bin, "")
	require.NotEmpty(t, good)
	require.NoError(t, os.WriteFile(good, []byte("not tmux"), 0o755)) // something else under the copy's name
	assert.Empty(t, stageTmux(data, bin, ""), "a file that is not the copy it should be is not trusted")

	assert.Empty(t, stageTmux("", bin, ""), "no data folder: nothing staged")
	assert.Empty(t, stageTmux(t.TempDir(), filepath.Join(bundle, "missing"), ""), "an unreadable source: nothing staged")
}

// NewClient with the app bundle's tmux starts from the staged copy, still with the bundle's terminfo; with no bundle it is as before.
func TestNewClientStartsTheBundledTmuxFromItsOwnCopy(t *testing.T) {
	skipWithoutUnixTmux(t)
	b := newFakeBundle(t, "exit 0")
	data := t.TempDir()

	c := NewClient(data)

	assert.Equal(t, filepath.Dir(filepath.Join(data, stagedDir, "x")), filepath.Dir(c.TmuxBin), "the copy in the data folder, not the bundle's file")
	assert.NotEqual(t, realPath(t, b.tmuxBin), realPath(t, c.TmuxBin))
	env := tmuxEnv(c.TmuxBin)
	require.NotNil(t, env)
	assert.Contains(t, env, "CORAL_TMUX_BIN="+c.TmuxBin, "the panes' helpers call the same copy")
	found := false
	for _, e := range env {
		if len(e) > 14 && e[:14] == "TERMINFO_DIRS=" {
			found = true
			assert.Contains(t, e, b.terminfo)
		}
	}
	assert.True(t, found, "the bundle's terminfo still goes with the copy")
}

// A copy that cannot be run (macOS refuses it, a signature check, no execute permission) is never used: Coral keeps the bundled file and says so, and agents still start (#12598).
func TestACopyThatCannotRunFallsBackToTheBundledFile(t *testing.T) {
	data := t.TempDir()
	bin := writeTmux(t, t.TempDir(), "echo v1")

	prev := canRun
	canRun = func(string) error { return os.ErrPermission }
	t.Cleanup(func() { canRun = prev })
	assert.Empty(t, stageTmux(data, bin, ""), "a copy that cannot run is not used")
	entries, _ := os.ReadDir(filepath.Join(data, stagedDir))
	assert.Empty(t, entries, "and not kept: a later start may try again")

	canRun = prev
	// The real check: a file that is no program at all cannot be started; a program that starts and exits with an error did run.
	junk := filepath.Join(t.TempDir(), "tmux")
	require.NoError(t, os.WriteFile(junk, []byte("not a program"), 0o755))
	assert.Empty(t, stageTmux(t.TempDir(), junk, ""), "a copy the system will not start falls back")
	assert.NotEmpty(t, stageTmux(t.TempDir(), writeTmux(t, t.TempDir(), "exit 1"), ""), "one that ran and exited nonzero did run")

	// And one made not executable afterwards is not trusted either.
	good := stageTmux(data, bin, "")
	require.NotEmpty(t, good)
	require.NoError(t, os.Chmod(good, 0o600))
	assert.Empty(t, stageTmux(data, bin, ""))
}

func TestTheStagedFolderIsMadePrivateAndAWritableCopyIsNotTrusted(t *testing.T) {
	data := t.TempDir()
	bin := writeTmux(t, t.TempDir(), "echo v1")
	require.NoError(t, os.MkdirAll(filepath.Join(data, stagedDir), 0o777))
	require.NoError(t, os.Chmod(filepath.Join(data, stagedDir), 0o777))
	good := stageTmux(data, bin, "")
	require.NotEmpty(t, good)
	fi, err := os.Stat(filepath.Join(data, stagedDir))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), fi.Mode().Perm(), "the folder is forced to owner-only")

	require.NoError(t, os.Chmod(good, 0o770)) // group-writable: someone else could have changed it
	assert.Empty(t, stageTmux(data, bin, ""), "a copy others can write is not trusted")
}

// A copy staged by an earlier start is run once too before it is used again (#12598): it may have been quarantined or re-signed since.
func TestAReusedCopyThatCannotRunFallsBackToo(t *testing.T) {
	data := t.TempDir()
	bin := writeTmux(t, t.TempDir(), "echo v1")
	good := stageTmux(data, bin, "")
	require.NotEmpty(t, good)

	prev := canRun
	canRun = func(string) error { return os.ErrPermission }
	t.Cleanup(func() { canRun = prev })
	assert.Empty(t, stageTmux(data, bin, ""))
	_, err := os.Stat(good)
	assert.NoError(t, err, "a copy a server may have been started from is never deleted")
}
