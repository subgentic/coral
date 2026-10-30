package startup

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
)

// A server names its run: the id is in the data folder's lock record AND in /api/health, so a command that finds the recorded address can tell this Coral from whatever
// holds that port after a crash (config.VerifiedServer).
func TestAStartedServerRecordsItsInstanceIdAndHealthAnswersIt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CORAL_NO_DEMO_SEED", "1")
	cfg := config.Load(t.TempDir())
	cfg.Host = "127.0.0.1"
	cfg.Port = 0                                            // port 0: Start reports the port it took in cfg.Port
	ctx, cancel := context.WithCancel(context.Background()) // the server's background services run until its context ends (#4167, goleak)
	rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
	if err != nil {
		cancel()
	}
	require.NoError(t, err)
	t.Cleanup(func() { cancel(); rs.Shutdown(5 * time.Second); rs.Close() })

	require.Regexp(t, `^[0-9a-f]{32}$`, cfg.InstanceID)
	raw, err := os.ReadFile(filepath.Join(cfg.CoralDir(), config.ServerLockFile))
	require.NoError(t, err)
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	require.Len(t, lines, 3, "pid, address, instance id")
	assert.Equal(t, cfg.InstanceID, lines[2])

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/api/health")
	require.NoError(t, err)
	defer resp.Body.Close()
	var h struct {
		Status     string `json:"status"`
		InstanceID string `json:"instance_id"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&h))
	assert.Equal(t, "ok", h.Status)
	assert.Equal(t, cfg.InstanceID, h.InstanceID)

	assert.NotEmpty(t, config.VerifiedServer(cfg.CoralDir()), "the running server verifies")
}
