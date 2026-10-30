package routes

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// cliOnlyOnPath puts a harmless program for each name alone on PATH (the folder it is in is the whole PATH) and returns the folder: the agent CLI a launch finds by the lookup
// the way a person's PATH gives it, with no cli_path setting (#353).
func cliOnlyOnPath(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		file, body := n, "#!/bin/sh\nexit 0\n"
		if runtime.GOOS == "windows" {
			file, body = n+".cmd", "@exit /b 0\r\n"
		}
		require.NoError(t, os.WriteFile(filepath.Join(dir, file), []byte(body), 0o755))
	}
	t.Setenv("PATH", dir)
	return dir
}

// noCLIAnywhere leaves PATH empty and the places a CLI is looked for next to it (home, %LOCALAPPDATA%, %APPDATA%) empty folders of the test's own, so no agent CLI can be found
// on this computer; and the lookup for an untrusted mount point answers nothing (this computer's real PATH may hold one, #340).
func noCLIAnywhere(t *testing.T) {
	t.Helper()
	t.Setenv("PATH", t.TempDir())
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("APPDATA", t.TempDir())
}
