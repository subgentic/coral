//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Claude Code's native Windows installer puts claude.exe in %USERPROFILE%\.local\bin and adds that folder to the user's Path, which a Coral that was already running does not see.
// The CLI check's "Install it from the official page, then check again" must find it there without a restart, as ~/.local/bin is found on macOS and Linux.

func windowsNativeHome(t *testing.T) string {
	t.Helper()
	here, err := filepath.Abs(".")
	require.NoError(t, err)
	home, err := os.MkdirTemp(here, "nativehome-") // not in the system temp folder, where a CLI is refused as a temporary one
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) }) // this folder only, by its exact name
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	appData, localAppData := filepath.Join(home, "AppData", "Roaming"), filepath.Join(home, "AppData", "Local")
	require.NoError(t, os.MkdirAll(appData, 0o755))
	require.NoError(t, os.MkdirAll(localAppData, 0o755))
	t.Setenv("APPDATA", appData)
	t.Setenv("LOCALAPPDATA", localAppData)
	t.Setenv("PATH", t.TempDir()) // the server's PATH from before the install: it does not hold %USERPROFILE%\.local\bin
	return home
}

func TestTheNativeWindowsInstallersClaudeIsFoundOffPath(t *testing.T) {
	home := windowsNativeHome(t)
	dir := filepath.Join(home, ".local", "bin")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	exe := filepath.Join(dir, "claude.exe")
	require.NoError(t, os.WriteFile(exe, []byte("x"), 0o755))

	assert.Equal(t, exe, CommonPlaceLookup("claude", nil).Path)
	got, err := LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, exe, got)
}

func TestNpmsFolderStaysAheadOfTheNativeWindowsFolder(t *testing.T) {
	home := windowsNativeHome(t)
	c := CommonPlaceCandidates("claude")
	npm := slices.Index(c, filepath.Join(home, "AppData", "Roaming", "npm", "claude.exe"))
	native := slices.Index(c, filepath.Join(home, ".local", "bin", "claude.exe"))
	require.NotEqual(t, -1, npm)
	require.NotEqual(t, -1, native)
	assert.Less(t, npm, native, "an install that worked before this change is found where it was")
}

func TestTheNativeWindowsFolderIsScreenedLikeEveryCommonPlace(t *testing.T) {
	home := windowsNativeHome(t)
	dir := filepath.Join(home, ".local", "bin")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "claude"), []byte("x"), 0o755)) // no extension: not a program Windows runs
	exe := filepath.Join(dir, "claude.exe")
	require.NoError(t, os.WriteFile(exe, []byte("x"), 0o755))

	refused := CommonPlaceLookup("claude", func(p string) string {
		if p == exe {
			return "in an agent's working folder"
		}
		return ""
	})
	assert.Empty(t, refused.Path, "the caller's screen still refuses it")
	assert.Equal(t, "not a program the system runs", refused.Refused, "the first file found and refused is named")
}
