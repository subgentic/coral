package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/updater/trigger"
)

// A test process cannot reach the real start of the person's Coral (TestMain), and a restart that has nothing but the registered install to go on
// stops the run instead of starting it.
func TestATestCannotReachTheRealStartOfCoral(t *testing.T) {
	assert.Panics(t, func() { _ = startCoralFrom(t.TempDir(), t.TempDir()) })
	assert.Panics(t, func() { _, _ = registeredInstall() })

	// The path that started the extra trays: a click marker with no folder, and nothing stubbed.
	old := restartGOOS
	restartGOOS = "windows"
	t.Cleanup(func() { restartGOOS = old })
	data := t.TempDir()
	require.NoError(t, trigger.WriteMarker(data, "1.5.0", "", time.Now()))
	assert.Panics(t, func() { restartAfterNothing(data, time.Now()) }, "it would have looked up the registered install")
}
