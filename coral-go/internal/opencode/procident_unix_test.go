//go:build !windows

package opencode

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ps's lstart on Linux is boot time plus start ticks and can read a second apart between two reads under load (#13412, as #13409): the same recorded server is still that process.
func TestARecordedServerWhoseStartTimeReadsSecondsApartIsStillTheSameProcess(t *testing.T) {
	me := os.Getpid()
	out, err := exec.Command("ps", "-o", "args=", "-p", strconv.Itoa(me)).Output()
	require.NoError(t, err)
	cmd := strings.TrimSpace(string(out))
	start := processStart(me)
	require.NotEmpty(t, start)
	at, err := time.ParseInLocation(psStartLayout, start, time.Local)
	require.NoError(t, err)
	shift := func(d time.Duration) string { return at.Add(d).Format(psStartLayout) }

	for _, d := range []time.Duration{0, time.Second, -time.Second, 2 * time.Second, -2 * time.Second} {
		assert.True(t, isRecordedServer(pidRecord{PID: me, Command: cmd, Started: shift(d)}), "recorded %v apart", d)
	}
	for _, d := range []time.Duration{3 * time.Second, -3 * time.Second, time.Hour} {
		assert.False(t, isRecordedServer(pidRecord{PID: me, Command: cmd, Started: shift(d)}), "a recycled pid starting %v apart is another process", d)
	}
	assert.False(t, isRecordedServer(pidRecord{PID: me, Command: cmd, Started: "garbage"}))
}
