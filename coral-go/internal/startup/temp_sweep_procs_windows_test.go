//go:build windows

package startup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #357: Windows has a process list for the sweep's "no running process names this session" guard. It holds this test's own process, so a launch file whose session a running
// process names is kept; before, the list was an error and the sweep removed nothing.
func TestWindowsHasAProcessListWithThisProcessInIt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	out, err := runningCommandLines(ctx)
	require.NoError(t, err)
	assert.NotEmpty(t, strings.TrimSpace(out))
	exe, err := os.Executable()
	require.NoError(t, err)
	assert.Contains(t, strings.ToLower(out), strings.ToLower(filepath.Base(exe)), "the list names this test binary")
}
