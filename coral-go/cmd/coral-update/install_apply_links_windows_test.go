//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/trigger"
)

// junction makes link point at target, and skips the test where this Windows refuses to traverse a link the user made (build 26300: "untrusted mount point"); CI runs it.
func junction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	require.NoError(t, err, "mklink /J: %s", out)
	if _, err := os.Stat(filepath.Join(link, ".")); err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("a junction made here cannot be traversed: %v", err)
		}
		t.Skipf("this Windows refuses to traverse a junction a user made: %v", err)
	}
}

// The marker's folder is compared with the registered install by FINAL path: a junction that leads to the registered folder is that folder, and a junction to another one is not.
func TestTheMarkersFolderIsComparedByItsFinalPath(t *testing.T) {
	t.Run("a junction to the registered install is the registered install", func(t *testing.T) {
		l := newLayout(t)
		link := filepath.Join(t.TempDir(), "Coral")
		junction(t, link, l.reg)
		require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", link, l.now))
		assert.True(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("a junction to another folder is not", func(t *testing.T) {
		l := newLayout(t)
		other := t.TempDir()
		link := filepath.Join(t.TempDir(), "Coral")
		junction(t, link, other)
		require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", link, l.now))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
}
