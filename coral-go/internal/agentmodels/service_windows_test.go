//go:build windows

package agentmodels

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A model-list or sign-in probe of a CLI that is a .cmd shim (claude.cmd runs node.exe as its child) ends the shim's child with it when the timeout comes (#349). The call itself already
// comes back at its deadline (cliCommand sets a WaitDelay); what the test catches is the orphan: while the child lives it holds the folder the probe ran in, and the test's own
// TempDir cleanup fails ("being used by another process").
func TestAProbeOfAShimWhoseChildHangsReturnsAtItsDeadline(t *testing.T) {
	p := filepath.Join(t.TempDir(), "claude.cmd")
	require.NoError(t, os.WriteFile(p, []byte("@echo off\r\nping -n 60 127.0.0.1 >nul\r\n"), 0o600))
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := runCLI(ctx, p, t.TempDir(), "--version")
	require.Error(t, err)
	assert.Less(t, time.Since(start), 10*time.Second, "the probe came back at its deadline, not when the shim's child ended")
}
