package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	setreg "github.com/subgentic/coral/internal/settings"
)

// The auto-sleep settings are the Operator's and are checked on the server (#12111, Security): a boolean, and a whole number of minutes from 15 to 1440 stored as a plain integer string.
func TestAutoSleepSettingsAreValidated(t *testing.T) {
	for _, bad := range []map[string]any{
		{setreg.AutoSleep: "yes"}, {setreg.AutoSleep: 1.0}, {setreg.AutoSleepIdleMinutes: 14.0}, {setreg.AutoSleepIdleMinutes: 1441.0},
		{setreg.AutoSleepIdleMinutes: 60.5}, {setreg.AutoSleepIdleMinutes: "x"}, {setreg.AutoSleepIdleMinutes: true}, {setreg.AutoSleepIdleMinutes: "0"}, {setreg.AutoSleepIdleMinutes: "-60"},
	} {
		assert.Error(t, validateAutoSleepSettings(bad), "%v", bad)
	}
	ok := map[string]any{setreg.AutoSleep: false, setreg.AutoSleepIdleMinutes: 90.0}
	require.NoError(t, validateAutoSleepSettings(ok))
	assert.Equal(t, "false", ok[setreg.AutoSleep])
	assert.Equal(t, "90", ok[setreg.AutoSleepIdleMinutes])
	ok = map[string]any{setreg.AutoSleepIdleMinutes: " 15 "}
	require.NoError(t, validateAutoSleepSettings(ok))
	assert.Equal(t, "15", ok[setreg.AutoSleepIdleMinutes])
}

// The registry's defaults: on, and an hour.
func TestAutoSleepDefaults(t *testing.T) {
	assert.True(t, setreg.Bool(map[string]string{}, setreg.AutoSleep), "on by default")
	assert.Equal(t, int64(60), setreg.Int(map[string]string{}, setreg.AutoSleepIdleMinutes))
	assert.Equal(t, int64(60), setreg.Int(map[string]string{setreg.AutoSleepIdleMinutes: "5"}, setreg.AutoSleepIdleMinutes), "out of range reads as the default")
}
