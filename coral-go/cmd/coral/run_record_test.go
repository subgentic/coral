package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/runrecord"
)

func readRecord(t *testing.T, dir string) (runrecord.Record, os.FileInfo) {
	t.Helper()
	p := filepath.Join(dir, "updates", runrecord.File)
	fi, err := os.Stat(p)
	require.NoError(t, err)
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	var rr runrecord.Record
	require.NoError(t, json.Unmarshal(b, &rr))
	return rr, fi
}

// #5339: the server records how it was started, for the Linux apply to start it again.
func TestRecordRunWritesTheProgramItsArgumentsAndTheWorkingDirectory(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("recorded on Linux only")
	}
	dir := t.TempDir()
	exe, err := os.Executable()
	require.NoError(t, err)
	cwd, err := os.Getwd()
	require.NoError(t, err)
	recordRun(dir, []string{"./relative/coral", "--port", "8420", "--no-browser"})
	rr, fi := readRecord(t, dir)
	assert.Equal(t, []string{exe, "--port", "8420", "--no-browser"}, rr.Argv, "the absolute running program, the arguments as given")
	assert.True(t, filepath.IsAbs(rr.Argv[0]))
	assert.Equal(t, cwd, rr.Cwd)
	assert.Equal(t, os.FileMode(0o600), fi.Mode().Perm())
	di, err := os.Stat(filepath.Join(dir, "updates"))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o700), di.Mode().Perm())

	recordRun(dir, []string{"coral"}) // a second start replaces it
	rr, _ = readRecord(t, dir)
	assert.Equal(t, []string{exe}, rr.Argv)
}

func TestRecordRunNeverRecordsASecretFlagAndNeverStopsCoral(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("recorded on Linux only")
	}
	dir := t.TempDir()
	recordRun(dir, []string{"coral", "--api-key=abc123"})
	_, err := os.Stat(filepath.Join(dir, "updates", runrecord.File))
	assert.ErrorIs(t, err, os.ErrNotExist, "a command line with a secret is not written")
	// nor does an empty command line or an unwritable folder panic
	recordRun(dir, nil)
	recordRun(filepath.Join(dir, "no", "such", "\x00bad"), []string{"coral"})
}

// #9056: every platform records where Coral lives, for the macOS and Windows relaunch.
func TestRecordLaunchWritesTheDataFolderHomeAndPort(t *testing.T) {
	dir := t.TempDir()
	recordLaunch(dir, 8461)
	got, err := runrecord.ReadLaunch(dir)
	require.NoError(t, err)
	assert.Equal(t, dir, got.DataDir)
	assert.Equal(t, 8461, got.Port)
	home, _ := os.UserHomeDir()
	assert.Equal(t, home, got.Home)
}
