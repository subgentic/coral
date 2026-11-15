//go:build !windows

package background

import (
	"bytes"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A umask of 002 (most Linux users' default; epoch's) makes git's worktree group-writable: the ticked job's run folder is still trusted, once the folder is made not writable by others.
func TestATickedJobTrustsItsRunsFolderUnderAGroupWritableUmask(t *testing.T) {
	old := syscall.Umask(0o002)
	t.Cleanup(func() { syscall.Umask(old) })
	_, during, run, _, _ := trustRunFixture(t, 1)
	r := run()
	require.NotNil(t, r.WorktreePath)
	assert.Contains(t, *during, filepath.Base(*r.WorktreePath), "the run's own folder was trusted although git made it group-writable")
	assert.Contains(t, *during, `"hasTrustDialogAccepted": true`)
}

// Security's MUST on #18031: under umask 002 everything git checked out is group-writable, and a trusted run would execute what a group member planted in it: every file and folder inside the run's folder loses
// group and other write, and a link inside is not followed (the file it points at, outside the folder, is not changed).
func TestARunFolderIsClosedToGroupWriteAllTheWayDown(t *testing.T) {
	old := syscall.Umask(0o002)
	t.Cleanup(func() { syscall.Umask(old) })
	outside := filepath.Join(t.TempDir(), "outside.txt")
	require.NoError(t, os.WriteFile(outside, []byte("x"), 0o666))
	require.NoError(t, os.Chmod(outside, 0o666))
	dir := filepath.Join(t.TempDir(), "job-run-1-x")
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "sub", "deep"), 0o775))
	file := filepath.Join(dir, "sub", "deep", "run.sh")
	require.NoError(t, os.WriteFile(file, []byte("#!/bin/sh\n"), 0o775))
	require.NoError(t, os.Chmod(file, 0o775))
	require.NoError(t, os.Symlink(outside, filepath.Join(dir, "link")))

	closeRunFolder(dir, slog.Default())

	require.NoError(t, filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.Type()&fs.ModeSymlink != 0 {
			return err
		}
		fi, err := os.Lstat(p)
		require.NoError(t, err)
		assert.Zero(t, fi.Mode().Perm()&0o022, "%s is still writable by group or others: %v", p, fi.Mode().Perm())
		return nil
	}))
	fi, err := os.Stat(file)
	require.NoError(t, err)
	assert.NotZero(t, fi.Mode().Perm()&0o100, "the owner keeps execute")
	ofi, err := os.Stat(outside)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o666), ofi.Mode().Perm(), "a link's target outside the folder is not changed")
}

// #18091 (Security, QA3): a path in the run's folder that cannot be read or closed is logged with its path, not swallowed; the rest of the folder is still closed.
func TestCloseRunFolderLogsWhatItCannotDo(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every folder")
	}
	dir := filepath.Join(t.TempDir(), "job-run-2-x")
	locked := filepath.Join(dir, "locked")
	require.NoError(t, os.MkdirAll(locked, 0o775))
	other := filepath.Join(dir, "other.txt")
	require.NoError(t, os.WriteFile(other, []byte("x"), 0o666))
	require.NoError(t, os.Chmod(other, 0o666))
	require.NoError(t, os.Chmod(locked, 0o000))
	t.Cleanup(func() { os.Chmod(locked, 0o700) })
	var buf bytes.Buffer
	closeRunFolder(dir, slog.New(slog.NewTextHandler(&buf, nil)))
	assert.Contains(t, buf.String(), "locked", "the path that could not be read is named")
	fi, err := os.Stat(other)
	require.NoError(t, err)
	assert.Zero(t, fi.Mode().Perm()&0o022, "the rest of the folder is still closed")
}
