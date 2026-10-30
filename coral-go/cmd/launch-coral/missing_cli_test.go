package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// With the agent's CLI nowhere (not on PATH, not in the common install places, not set), no session is made and no launch line is typed: the folder is skipped with the reason
// (#353). The shell would otherwise answer the bare name with "codex is not recognized" in the pane.
func TestLaunchAgentSessionsSkipsAFolderWhenTheCLIIsMissing(t *testing.T) {
	empty := t.TempDir()
	t.Setenv("PATH", empty)
	for _, k := range []string{"HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		t.Setenv(k, empty)
	}
	target := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(target, "worktree-a"), 0o755))

	// a nil tmux client: nothing may reach it
	names, err := launchAgentSessions(context.Background(), nil, config.Load(t.TempDir()), target, "codex", t.TempDir(), nil)
	require.NoError(t, err)
	require.Empty(t, names, "no session was made for an agent whose CLI is missing")
}

// A CLI path saved in Settings > CLI paths is used: with PATH empty and the CLI nowhere else, the launch is not refused (the tmux client is nil, so reaching it is the proof the
// CLI step passed), and the settings come from the data folder's database read-only: nothing is created and a missing database means no settings.
func TestSavedCLIPathIsReadFromTheDataFolderAndUsed(t *testing.T) {
	empty := t.TempDir()
	t.Setenv("PATH", empty)
	for _, k := range []string{"HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		t.Setenv(k, empty)
	}
	exe, err := os.Executable()
	require.NoError(t, err)
	fake := filepath.Join(t.TempDir(), "codex")
	if runtime.GOOS == "windows" {
		fake += ".exe"
	}
	body, err := os.ReadFile(exe)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(fake, body, 0o755))

	data := t.TempDir()
	dbPath := filepath.Join(data, "sessions.db")

	// no database yet: no settings, and nothing is created
	require.Nil(t, savedSettings(context.Background(), dbPath))
	_, statErr := os.Stat(dbPath)
	require.True(t, os.IsNotExist(statErr), "reading the settings must not create the database")

	db, err := store.OpenWithKey(context.Background(), dbPath, "")
	require.NoError(t, err)
	require.NoError(t, store.NewSessionStore(db).SetSetting(context.Background(), "cli_path_codex", fake))
	require.NoError(t, db.Close())
	before, err := os.Stat(dbPath)
	require.NoError(t, err)

	settings := savedSettings(context.Background(), dbPath)
	require.Equal(t, fake, settings["cli_path_codex"])
	after, err := os.Stat(dbPath)
	require.NoError(t, err)
	require.Equal(t, before.ModTime(), after.ModTime(), "the database was only read")

	// with the saved path the launch gets past the CLI step (and then meets the nil tmux client)
	target := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(target, "worktree-a"), 0o755))
	require.Panics(t, func() {
		_, _ = launchAgentSessions(context.Background(), nil, config.Load(t.TempDir()), target, "codex", t.TempDir(), settings)
	}, "the saved CLI path was used: the launch went on to make a tmux session")

	// a saved path that cannot be run is refused, not replaced by another CLI
	bad := map[string]string{"cli_path_codex": filepath.Join(empty, "no-such-codex.exe")}
	names, err := launchAgentSessions(context.Background(), nil, config.Load(t.TempDir()), target, "codex", t.TempDir(), bad)
	require.NoError(t, err)
	require.Empty(t, names)
}

// A database that is there but cannot be read (damaged here) means no saved settings and a warning: no crash, nothing rewritten.
func TestSavedSettingsOfAnUnreadableDatabaseAreNone(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "sessions.db")
	require.NoError(t, os.WriteFile(dbPath, []byte("this is not a sqlite database at all, just text\n"), 0o600))
	require.Nil(t, savedSettings(context.Background(), dbPath))
	got, err := os.ReadFile(dbPath)
	require.NoError(t, err)
	require.Equal(t, "this is not a sqlite database at all, just text\n", string(got), "the file was left as it was")
}
