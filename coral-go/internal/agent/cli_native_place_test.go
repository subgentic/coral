//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11454: Claude Code's native installer puts ~/.local/bin/claude (a link into ~/.local/share/claude/versions/<v>) and an older one ~/.claude/local/claude. Both are fixed common places, the link is
// the answer (never the version it points at: the updater moves it), and a refusal is named.

func nativeHome(t *testing.T) string {
	t.Helper()
	here, err := filepath.Abs(".")
	require.NoError(t, err)
	home, err := os.MkdirTemp(here, "nativehome-") // not in the system temp folder, where a CLI is refused as a temporary one
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(home) }) // this folder only, by its exact name
	t.Setenv("HOME", home)
	t.Setenv("PATH", t.TempDir()) // the server's PATH: it does not hold ~/.local/bin
	return home
}

func TestTheNativeInstallersLinkIsFoundOnAPathWithoutItAndFollowedAtEachLaunch(t *testing.T) {
	home := nativeHome(t)
	versions := filepath.Join(home, ".local", "share", "claude", "versions")
	require.NoError(t, os.MkdirAll(versions, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755))
	v1 := filepath.Join(versions, "2.1.316")
	require.NoError(t, os.WriteFile(v1, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	link := filepath.Join(home, ".local", "bin", "claude")
	require.NoError(t, os.Symlink(v1, link))

	got, err := LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, link, got, "the link, not the version file")

	v2 := filepath.Join(versions, "2.1.317")
	require.NoError(t, os.WriteFile(v2, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	require.NoError(t, os.Remove(link))
	require.NoError(t, os.Symlink(v2, link))
	got, err = LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, link, got, "the same path after the updater moved the link: nothing was kept")
}

func TestTheOlderNativeInstallPlaceIsProbed(t *testing.T) {
	home := nativeHome(t)
	dir := filepath.Join(home, ".claude", "local")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	p := filepath.Join(dir, "claude")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	got, err := LaunchCLI(nil, "claude")
	require.NoError(t, err)
	assert.Equal(t, p, got)
	assert.Contains(t, CommonPlaceCandidates("claude"), p)
	assert.NotContains(t, CommonPlaceCandidates("codex"), filepath.Join(dir, "codex"), "only claude has that place")
}

func TestTheNotFoundAnswerNamesWhatWasRefusedAndWhereItLooked(t *testing.T) {
	home := nativeHome(t)
	require.NoError(t, os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755))
	p := filepath.Join(home, ".local", "bin", "claude")
	require.NoError(t, os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755))
	_, err := LaunchCLIScreened(nil, "claude", func(string) string { return "in an agent's working folder" })
	var nf *CLINotFoundError
	require.ErrorAs(t, err, &nf)
	assert.Equal(t, "in an agent's working folder", nf.Refused)
	assert.Equal(t, p, nf.RefusedPath)
	msg := nf.Error()
	assert.Contains(t, msg, "Coral found ~/.local/bin/claude and did not use it: it is in an agent's working folder")
	assert.Contains(t, msg, "~/.claude/local/claude")
	assert.Contains(t, msg, "the PATH it runs with")
	assert.NotContains(t, msg, home, "the answer writes the home folder as ~")
	assert.Contains(t, msg, "After installing, run claude once in a terminal to sign in", "the step after the install")
	assert.Contains(t, msg, "on a computer with no screen, use the Hub's Terminal")

	// nothing found anywhere: the places are named, no refusal is invented
	require.NoError(t, os.Remove(p))
	_, err = LaunchCLI(nil, "claude")
	require.ErrorAs(t, err, &nf)
	assert.Empty(t, nf.Refused)
	assert.NotContains(t, nf.Error(), "did not use it")
	assert.Contains(t, nf.Error(), "~/.local/bin/claude")
}
