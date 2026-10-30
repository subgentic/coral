package agent

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// pathWithStub makes a runnable program called name, puts its folder alone on PATH, and returns its path.
func pathWithStub(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	file := name
	if runtime.GOOS == "windows" {
		file += ".exe"
	}
	p := filepath.Join(dir, file)
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	t.Setenv("PATH", dir)
	return p
}

// A configured cli_path_<agent> that is missing or not a program is refused with an error naming the setting and the path; the claude
// that is first on PATH is never run in its place (#115).
func TestLaunchCLIRefusesAConfiguredPathThatCannotBeRun(t *testing.T) {
	onPath := pathWithStub(t, "claude")
	key := CLIPathSettingKey("claude")

	t.Run("set and missing", func(t *testing.T) {
		gone := filepath.Join(t.TempDir(), "gone", "claude")
		got, err := LaunchCLI(map[string]string{key: gone}, "claude")
		require.Error(t, err)
		assert.Empty(t, got)
		assert.Contains(t, err.Error(), key)
		assert.Contains(t, err.Error(), gone)
		assert.NotContains(t, err.Error(), onPath)
	})
	t.Run("set and not executable", func(t *testing.T) {
		notProg := filepath.Join(t.TempDir(), "claude.txt") // no execute bit on Unix; not an executable extension on Windows
		require.NoError(t, os.WriteFile(notProg, []byte("not a program"), 0o644))
		got, err := LaunchCLI(map[string]string{key: notProg}, "claude")
		require.Error(t, err)
		assert.Empty(t, got)
		assert.Contains(t, err.Error(), key)
		assert.Contains(t, err.Error(), notProg)
	})
	t.Run("set and runnable", func(t *testing.T) {
		mine := pathWithStub(t, "my-claude")
		got, err := LaunchCLI(map[string]string{key: mine}, "claude")
		require.NoError(t, err)
		assert.Equal(t, mine, got)
	})
}

// With no cli_path set the program is the absolute path found on PATH, not a bare name looked up again by the agent's shell (#115).
func TestLaunchCLIUnsetResolvesToAnAbsolutePath(t *testing.T) {
	onPath := pathWithStub(t, "claude")
	got, err := LaunchCLI(map[string]string{}, "claude")
	require.NoError(t, err)
	assert.True(t, filepath.IsAbs(got), "got %q", got)
	assert.Equal(t, onPath, got)

}

// A CLI found nowhere is an error, never "": the launch line would type the bare name and the shell answer "claude is not recognized" (#353). It is the error a new launch gives.
func TestLaunchCLIFoundNowhereIsCLINotFound(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", t.TempDir()) // no ~/.local/bin or nvm installs from the real home
	t.Setenv("USERPROFILE", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
	for _, typ := range []string{"claude", "codex", "gemini", "agy", "pi"} {
		if GetCLIInfo(typ) == nil {
			continue
		}
		if p := FindCLIInCommonPaths(GetCLIInfo(typ).Binary); p != "" {
			// A CLI really installed in a fixed system folder (/usr/local/bin, /opt/homebrew/bin, /snap/bin) cannot be hidden from a test by its environment: this machine has one, so
			// the "found nowhere" case cannot be shown for it here. It runs on a machine without that install (CI).
			t.Logf("%s: skipped, a real install is at %s", typ, p)
			continue
		}
		got, err := LaunchCLI(nil, typ)
		var nf *CLINotFoundError
		require.ErrorAs(t, err, &nf, typ)
		assert.Empty(t, got, typ)
		assert.Equal(t, typ, nf.AgentType)
		assert.Contains(t, err.Error(), "CLI not found", typ)
		assert.Contains(t, err.Error(), CLIPathSettingKey(typ), typ)
	}
	// A plain terminal has no CLI to find.
	got, err := LaunchCLI(nil, "terminal")
	require.NoError(t, err)
	assert.Empty(t, got)
}

// A CLI that is not on PATH but is in a common install place is found there, as a new launch finds it.
func TestLaunchCLIFindsACommonInstallPlace(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	local, home := t.TempDir(), t.TempDir()
	t.Setenv("LOCALAPPDATA", local)
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir, name := filepath.Join(home, ".local", "bin"), "agy" // Linux and macOS
	if runtime.GOOS == "windows" {
		dir, name = filepath.Join(local, "agy", "bin"), "agy.exe"
	}
	require.NoError(t, os.MkdirAll(dir, 0o755))
	exe := filepath.Join(dir, name)
	require.NoError(t, os.WriteFile(exe, []byte("x"), 0o755))

	// The test's own folders are in the temp folder, where a CLI is never picked up from a common place (CommonPlaceCLI): so the temp folder is another one for this test.
	// t.TempDir folders share a parent, and with GOTMPDIR set that parent is not os.TempDir(): make it the temp folder.
	for _, k := range []string{"TMP", "TEMP", "TMPDIR"} {
		t.Setenv(k, filepath.Dir(local))
	}
	got, err := LaunchCLI(nil, "agy")
	var nf *CLINotFoundError
	require.ErrorAs(t, err, &nf, "a CLI in the temp folder is not picked up")
	assert.Empty(t, got)
	elsewhere := t.TempDir()
	t.Setenv("TMP", elsewhere)
	t.Setenv("TEMP", elsewhere)
	t.Setenv("TMPDIR", elsewhere)
	got, err = LaunchCLI(nil, "agy")
	require.NoError(t, err)
	assert.Equal(t, exe, got)
}

// A codex in the working directory is not a CLI to start, whether PATH names the current folder ("." or an empty entry) or, on Windows, the folder is searched implicitly (Go reports a
// current-folder hit as exec.ErrDot and LaunchCLI takes none of them): the old check was filepath.IsAbs on the result, and this keeps the rule visible (#353, Security).
func TestLaunchCLIDoesNotPickUpACLIInTheWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	name, body := "codex", "#!/bin/sh\nexit 0\n"
	if runtime.GOOS == "windows" {
		name, body = "codex.cmd", "@exit /b 0\r\n"
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755))
	t.Chdir(dir)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
	prev := UntrustedMountDir
	UntrustedMountDir = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { UntrustedMountDir = prev })
	for _, path := range []string{".", "", string(os.PathListSeparator) + t.TempDir(), t.TempDir() + string(os.PathListSeparator) + "."} {
		t.Setenv("PATH", path)
		got, err := LaunchCLI(nil, "codex")
		var nf *CLINotFoundError
		require.ErrorAs(t, err, &nf, "PATH=%q", path)
		assert.Empty(t, got, "PATH=%q", path)
	}
}
