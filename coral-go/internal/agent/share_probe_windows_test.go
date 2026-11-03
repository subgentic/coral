//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// npm's folder on a share that does not answer: the lookup and the launch go on without it, and the launch's answer says why in the fixed sentence.
func TestAnNpmFolderOnAShareThatDoesNotAnswerIsSkippedAndSaidSo(t *testing.T) {
	home := windowsNativeHome(t)
	npm := filepath.Join(home, "AppData", "Roaming", "npm")
	require.NoError(t, os.MkdirAll(npm, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(npm, "claude.cmd"), []byte("@echo off"), 0o755))
	release := make(chan struct{})
	useShareFake(t, npm, release)
	t.Cleanup(func() { close(release) })

	_, err := LaunchCLI(nil, "claude")
	var nf *CLINotFoundError
	require.ErrorAs(t, err, &nf)
	assert.True(t, nf.ShareNotAnswered)
	assert.Contains(t, err.Error(), ShareNotAnsweredNote("claude"))
	assert.NotContains(t, ShareNotAnsweredNote("claude"), home, "the sentence names no folder")
	assert.True(t, ShareSkipped("claude"))
	assert.Empty(t, FindCLIInCommonPaths("claude"), "the stat-only lookup skips it too")
}

// The same folder on a share that answers: found as before.
func TestAnNpmFolderOnAShareThatAnswersIsFound(t *testing.T) {
	home := windowsNativeHome(t)
	npm := filepath.Join(home, "AppData", "Roaming", "npm")
	require.NoError(t, os.MkdirAll(npm, 0o755))
	cmd := filepath.Join(npm, "claude.cmd")
	require.NoError(t, os.WriteFile(cmd, []byte("@echo off"), 0o755))
	useShareFake(t, npm, nil)
	got, err := LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, cmd, got)
	assert.False(t, ShareSkipped("claude"))
}

// Only "the share answered" is remembered, never a path: a CLI removed from the share within the window is not found by the next lookup.
func TestACLIRemovedFromAShareIsNotFoundEvenWithinTheWindow(t *testing.T) {
	home := windowsNativeHome(t)
	npm := filepath.Join(home, "AppData", "Roaming", "npm")
	require.NoError(t, os.MkdirAll(npm, 0o755))
	cmd := filepath.Join(npm, "claude.cmd")
	require.NoError(t, os.WriteFile(cmd, []byte("@echo off"), 0o755))
	f := useShareFake(t, npm, nil)
	got, err := LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, cmd, got)
	require.NoError(t, os.Remove(cmd))
	_, err = LaunchCLI(nil, "claude")
	require.Error(t, err, "the removed CLI is not remembered")
	assert.Equal(t, int32(1), f.calls.Load(), "and the share was not probed again within the window")
}
