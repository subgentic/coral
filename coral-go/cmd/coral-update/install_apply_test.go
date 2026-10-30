package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/updater/status"
	"github.com/subgentic/coral/internal/updater/trigger"
)

// layout is a registered install (reg, with its coral-update.exe), a data folder with the dashboard's copy of that updater in updates/apply, and the click's marker.
type layout struct {
	data, reg, exe string
	now            time.Time
}

func newLayout(t *testing.T) layout {
	t.Helper()
	root := t.TempDir()
	l := layout{data: filepath.Join(root, "data"), reg: filepath.Join(root, "Program Files", "Coral"), now: time.Now()}
	require.NoError(t, os.MkdirAll(l.reg, 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(l.data, "updates", "apply"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(l.reg, "coral-update.exe"), []byte("the installed updater"), 0o755))
	l.exe = filepath.Join(l.data, "updates", "apply", "coral-update-123.exe")
	require.NoError(t, os.WriteFile(l.exe, []byte("the installed updater"), 0o755))
	require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", l.reg, l.now))
	return l
}

// The dashboard starts the apply from a copy in <data>/updates/apply, which is never the install folder: the copy is the registered updater when the click's marker names the
// registered folder and the copy is that program's bytes, and for nothing else.
func TestTheDashboardsCopyOfTheRegisteredUpdaterIsJudgedAsTheRegisteredInstall(t *testing.T) {
	l := newLayout(t)
	assert.True(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now), "the real flow")
	_, err := trigger.Peek(l.data, l.now)
	assert.NoError(t, err, "judging the copy does not use up the click: the apply consumes it")
	_, err = trigger.Consume(l.data, l.now)
	assert.NoError(t, err)
}

func TestACopyIsNotTheRegisteredUpdaterUnlessEverythingHolds(t *testing.T) {
	t.Run("the marker names another folder", func(t *testing.T) {
		l := newLayout(t)
		other := filepath.Join(t.TempDir(), "Coral")
		require.NoError(t, os.MkdirAll(other, 0o755))
		require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", other, l.now))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("the marker names no folder (an older server)", func(t *testing.T) {
		l := newLayout(t)
		require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", "", l.now))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("no marker: a copy run by hand", func(t *testing.T) {
		l := newLayout(t)
		trigger.RemoveMarker(l.data)
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("an expired marker", func(t *testing.T) {
		l := newLayout(t)
		require.NoError(t, trigger.WriteMarker(l.data, "2.0.5", l.reg, l.now.Add(-trigger.MarkerTTL-time.Minute)))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("a damaged marker", func(t *testing.T) {
		l := newLayout(t)
		require.NoError(t, os.WriteFile(filepath.Join(l.data, "updates", "install-trigger.json"), []byte("{not json"), 0o600))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("the copy's bytes are not the registered updater's", func(t *testing.T) {
		l := newLayout(t)
		require.NoError(t, os.WriteFile(l.exe, []byte("a program that took its name"), 0o755))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("the registered folder has no coral-update.exe", func(t *testing.T) {
		l := newLayout(t)
		require.NoError(t, os.Remove(filepath.Join(l.reg, "coral-update.exe")))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, l.exe, l.now))
	})
	t.Run("a portable updater run by hand beside the product, even with a marker naming the product", func(t *testing.T) {
		l := newLayout(t)
		hand := filepath.Join(t.TempDir(), "coral-update-9.exe")
		require.NoError(t, os.WriteFile(hand, []byte("the installed updater"), 0o755))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, hand, l.now), "not in <data>/updates/apply")
	})
	t.Run("the updater under its install name in the apply folder", func(t *testing.T) {
		l := newLayout(t)
		named := filepath.Join(l.data, "updates", "apply", "coral-update.exe")
		require.NoError(t, os.WriteFile(named, []byte("the installed updater"), 0o755))
		assert.False(t, copyOfTheRegisteredUpdater(l.reg, l.data, named, l.now), "only the copies the trigger names coral-update-*.exe")
	})
	t.Run("nothing registered", func(t *testing.T) {
		l := newLayout(t)
		assert.False(t, copyOfTheRegisteredUpdater("", l.data, l.exe, l.now))
	})
}

// A refused apply after a click starts Coral again: the server quit for it, and the answer is kept in updates/apply.log (it went to the null device, so nobody saw it).
func TestAnApplyRefusedAsPortableAfterAClickStartsCoralAgainAndKeepsTheAnswer(t *testing.T) {
	if !config.TierChecksForUpdates {
		t.Skip("a build of another tier answers off")
	}
	oldVersion := config.Version
	t.Cleanup(func() { config.Version = oldVersion })
	config.Version = "2.0.3"
	oldApply, oldProbe := applyEnabled, applyProbe
	t.Cleanup(func() { applyEnabled, applyProbe = oldApply, oldProbe })
	applyEnabled = true
	applyProbe = func(string) *status.Install {
		return &status.Install{Kind: "portable", Unsupported: "portable_install"}
	}
	started := fakeStart(t, nil)
	data, install := t.TempDir(), installFolder(t)
	t.Setenv("CORAL_DATA_DIR", data)
	require.NoError(t, trigger.WriteMarker(data, "2.0.5", install, time.Now()))
	code, out := runOut(t, nil, "apply")
	assert.Equal(t, 0, code)
	assert.Equal(t, "unsupported_install", out["result"])
	assert.Equal(t, "portable_install", out["failed_stage"])
	assert.NotContains(t, out, "restart_failed")
	assert.Equal(t, []string{install}, *started, "the server that quit for the click is started again")
	b, err := os.ReadFile(filepath.Join(data, "updates", "apply.log"))
	require.NoError(t, err)
	assert.Contains(t, string(b), "portable_install", "the answer is kept")

	t.Run("run by hand: no click, no restart", func(t *testing.T) {
		started := fakeStart(t, nil)
		t.Setenv("CORAL_DATA_DIR", t.TempDir())
		_, out := runOut(t, nil, "apply")
		assert.Equal(t, "unsupported_install", out["result"])
		assert.Empty(t, *started)
	})
}

// When the click's marker names the registered install, Coral is started by Windows Installer's own spelling of the folder.
func TestTheRegisteredInstallIsStartedByItsOwnSpelling(t *testing.T) {
	started := fakeStart(t, nil)
	reg := installFolder(t)
	registered(t, reg, nil)
	assert.True(t, restartFromMarker(t.TempDir(), reg+string(filepath.Separator)))
	assert.Equal(t, []string{reg}, *started)
	other := installFolder(t) // a portable copy's server: its own folder is where it comes back
	assert.True(t, restartFromMarker(t.TempDir(), other))
	assert.Equal(t, []string{reg, other}, *started)
}
