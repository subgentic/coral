//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// savedPathIs makes the saved Path these folders for the test, and forgets what an earlier Check again found.
func savedPathIs(t *testing.T, reads *int, dirs ...string) {
	t.Helper()
	prev := readSavedPath
	readSavedPath = func() []string { *reads++; return dirs }
	savedPathFolders.Store(nil)
	t.Cleanup(func() { readSavedPath = prev; savedPathFolders.Store(nil) })
}

// An installer that put its folder on the person's saved Path after Coral started: the CLI is found after a Check again, not before, and without a restart.
func TestACLIInAFolderTheSavedPathGainedIsFoundAfterCheckAgain(t *testing.T) {
	home := windowsNativeHome(t)
	dir := filepath.Join(home, "Programs", "SomeInstaller", "bin")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	exe := filepath.Join(dir, "codex.exe")
	require.NoError(t, os.WriteFile(exe, []byte("x"), 0o755))
	reads := 0
	savedPathIs(t, &reads, dir)

	_, err := LaunchCLI(nil, "codex")
	require.Error(t, err, "before a Check again the running Coral's PATH is all it knows")
	assert.Zero(t, reads, "a launch never reads the saved Path itself")

	assert.Equal(t, 1, RefreshSavedPath())
	assert.Equal(t, 1, reads)
	got, err := LaunchCLI(nil, "codex")
	require.NoError(t, err)
	assert.Equal(t, exe, got)
	assert.Equal(t, exe, CommonPlaceLookup("codex", nil).Path)
	assert.Equal(t, 1, reads, "found from what the Check again kept, not by reading again")
}

// Folders already on this process's PATH, relative entries and repeats are not kept: only what the running Coral is missing.
func TestRefreshSavedPathKeepsOnlyAbsoluteFoldersThePathLacks(t *testing.T) {
	home := windowsNativeHome(t)
	onPath := t.TempDir()
	t.Setenv("PATH", onPath)
	gained := filepath.Join(home, "gained")
	reads := 0
	savedPathIs(t, &reads, onPath, "  ", `relative\bin`, gained, gained+`\`, filepath.Join(home, "GAINED"))

	assert.Equal(t, 1, RefreshSavedPath())
	assert.Equal(t, []string{gained}, savedPathDirsFound())
}

// A CLI found through the saved Path is screened like every common place: the caller's refusal stands.
func TestACLIFoundThroughTheSavedPathIsScreened(t *testing.T) {
	home := windowsNativeHome(t)
	dir := filepath.Join(home, "work")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	exe := filepath.Join(dir, "codex.exe")
	require.NoError(t, os.WriteFile(exe, []byte("x"), 0o755))
	reads := 0
	savedPathIs(t, &reads, dir)
	RefreshSavedPath()

	got := CommonPlaceLookup("codex", func(p string) string {
		if p == exe {
			return "in an agent's working folder"
		}
		return ""
	})
	assert.Empty(t, got.Path)
	assert.Equal(t, "in an agent's working folder", got.Refused)
}

// The real reader: the saved Path Windows keeps for every account has absolute folders (System32 among them), each expanded (no %SystemRoot% left).
func TestTheSavedPathIsReadFromTheRegistry(t *testing.T) {
	dirs := savedPathDirs()
	require.NotEmpty(t, dirs)
	sys := false
	for _, d := range dirs {
		assert.NotContains(t, d, "%SystemRoot%", "REG_EXPAND_SZ values are expanded")
		if filepath.Base(filepath.Clean(d)) == "System32" || filepath.Base(filepath.Clean(d)) == "system32" {
			sys = true
		}
	}
	assert.True(t, sys, "the system's Path holds System32")
}
