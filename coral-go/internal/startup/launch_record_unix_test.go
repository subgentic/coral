//go:build !windows

package startup

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/updater/runrecord"
)

// #9056: every server start records where it lives, so the macOS and Windows relaunch after an update comes back as the same Coral. The installed app's server is the tray's child, which
// reaches startup.Start but not cmd/coral's main: the record is written by Start itself.
func TestStartRecordsWhereTheServerLivesForTheRelaunch(t *testing.T) {
	var home string
	bootWithStubCLIsNoWatch(t, func(ctx context.Context, db *store.DB, h string) { home = h })
	launch, err := runrecord.ReadLaunch(home)
	require.NoError(t, err, "updates/launch.json is there after a start")
	assert.Equal(t, home, launch.DataDir, "the data folder it runs on")
	userHome, _ := os.UserHomeDir()
	assert.Equal(t, userHome, launch.Home)
	require.NotZero(t, launch.Port, "the port it was given")
	c := &http.Client{Timeout: 5 * time.Second}
	var resp *http.Response
	require.Eventually(t, func() bool {
		var err error
		resp, err = c.Get("http://127.0.0.1:" + strconv.Itoa(launch.Port) + "/api/health")
		return err == nil
	}, 10*time.Second, 50*time.Millisecond, "the recorded port is the one this server answers on")
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
