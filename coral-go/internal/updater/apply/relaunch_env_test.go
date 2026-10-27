package apply

import (
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/updater/runrecord"
)

// #9056: the Windows relaunch's arguments and environment (the process start itself is Windows-only).
func TestTrayStartArgsCarryTheRecordedPort(t *testing.T) {
	assert.Equal(t, []string{"--no-browser"}, trayStartArgs(false, runrecord.Launch{}))
	assert.Equal(t, []string{}, trayStartArgs(true, runrecord.Launch{}), "the window was open")
	assert.Equal(t, []string{"--no-browser", "--port", "8461"}, trayStartArgs(false, runrecord.Launch{Port: 8461}))
	assert.Equal(t, []string{"--port", "8461"}, trayStartArgs(true, runrecord.Launch{Port: 8461}))
}

func TestWithDataDirSetsTheRecordedFolderOnce(t *testing.T) {
	env := []string{"PATH=x", "CORAL_DATA_DIR=C:\\other", "Coral_Data_Dir=C:\\dup", "HOME=h"}
	assert.Equal(t, []string{"PATH=x", "HOME=h", "CORAL_DATA_DIR=D:\\iso\\data"}, withDataDir(env, "D:\\iso\\data"))
	assert.Equal(t, env, withDataDir(env, ""), "nothing recorded: as it was")
}
