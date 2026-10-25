package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
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
	names, err := launchAgentSessions(context.Background(), nil, config.Load(t.TempDir()), target, "codex", t.TempDir())
	require.NoError(t, err)
	require.Empty(t, names, "no session was made for an agent whose CLI is missing")
}
