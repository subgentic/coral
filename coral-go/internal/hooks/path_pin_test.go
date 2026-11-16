package hooks

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func toolsDirWith(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	return dir
}

// #18643: an agent's shell ran the installed app's older coral-agent although the launch line put this build's folder first; the hook's env-file line puts it first again after
// whatever the shell did to PATH. The test is the real thing: a shell sources the env file the way the CLI does, with an older tool first on PATH, and runs "coral-agent".
func TestPinToolsPathBeatsAnOlderToolFirstOnPath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	mine := toolsDirWith(t, "coral-agent", "echo new")
	older := toolsDirWith(t, "coral-agent", "echo old")
	envFile := filepath.Join(t.TempDir(), "env.sh")

	run := func() string {
		cmd := exec.Command("/bin/sh", "-c", `. "$ENVF" && coral-agent`)
		cmd.Env = []string{"ENVF=" + envFile, "PATH=" + older + ":" + mine + ":/usr/bin:/bin"}
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		return strings.TrimSpace(string(out))
	}
	require.NoError(t, os.WriteFile(envFile, nil, 0o600))
	assert.Equal(t, "old", run(), "without the line the older tool wins: the bug")

	require.NoError(t, PinToolsPath(envFile, mine))
	assert.Equal(t, "new", run(), "with the line this build's tool wins")
}

func TestPinToolsPathWritesOnceAndOnlyForAToolsFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	mine := toolsDirWith(t, "coral-board", "true")
	envFile := filepath.Join(t.TempDir(), "env.sh")
	for i := 0; i < 3; i++ { // SessionStart fires again on a resume, a clear and a compaction
		require.NoError(t, PinToolsPath(envFile, mine))
	}
	b, err := os.ReadFile(envFile)
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(string(b), "export PATH="), "one line, not one per start")

	other := filepath.Join(t.TempDir(), "elsewhere")
	require.NoError(t, os.MkdirAll(other, 0o755))
	envFile2 := filepath.Join(t.TempDir(), "env2.sh")
	require.NoError(t, PinToolsPath(envFile2, other))
	_, err = os.Stat(envFile2)
	assert.True(t, os.IsNotExist(err), "a folder with no coral-agent or coral-board is not pinned")

	require.NoError(t, PinToolsPath("", mine), "no env file offered: nothing to do")
}

func TestPinLineQuotesAFolderWithAQuoteAndASpace(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "it's a dir $HOME")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "coral-agent"), []byte("#!/bin/sh\necho ok\n"), 0o755))
	envFile := filepath.Join(base, "env.sh")
	require.NoError(t, PinToolsPath(envFile, dir))
	cmd := exec.Command("/bin/sh", "-c", `. "$ENVF" && coral-agent`)
	cmd.Env = []string{"ENVF=" + envFile, "PATH=/usr/bin:/bin"}
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Equal(t, "ok", strings.TrimSpace(string(out)))
}
