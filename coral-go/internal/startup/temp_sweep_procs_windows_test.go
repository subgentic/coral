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

// With SystemRoot unset, the path still comes from the system API and is absolute: nothing relative is ever run from the current folder.
func TestWindowsPowerShellPathDoesNotDependOnTheEnvironment(t *testing.T) {
	t.Setenv("SystemRoot", "")
	t.Setenv("windir", "")
	ps, err := systemPowerShell()
	require.NoError(t, err)
	assert.True(t, filepath.IsAbs(ps), ps)
	assert.True(t, strings.HasSuffix(strings.ToLower(ps), strings.ToLower(filepath.Join("system32", "windowspowershell", "v1.0", "powershell.exe"))), ps)
	_, serr := os.Stat(ps)
	assert.NoError(t, serr, "it is the real Windows PowerShell")
	// Windows PowerShell itself may refuse to start without SystemRoot: then the answer is an error and the sweep keeps every file. What must never happen is a relative program being run.
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if out, err := runningCommandLines(ctx); err == nil {
		assert.NotEmpty(t, strings.TrimSpace(out))
	}
}
