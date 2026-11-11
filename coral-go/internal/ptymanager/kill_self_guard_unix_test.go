//go:build !windows

package ptymanager

import (
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// #15011: the signal the terminal's tree-kill sends goes through the guard: a recorded pid that is Coral's own gets nothing. SIGUSR1 stands for SIGKILL here, so the test survives if the guard is missing (it is
// then delivered, and the test fails by saying so).
func TestTheTreeKillNeverSignalsCoralItself(t *testing.T) {
	got := make(chan os.Signal, 1)
	signal.Notify(got, syscall.SIGUSR1)
	defer signal.Stop(got)
	defaultKillSeams.sendSignal(os.Getpid(), syscall.SIGUSR1)
	select {
	case <-got:
		t.Fatal("Coral signalled itself")
	case <-time.After(300 * time.Millisecond):
	}
	assert.True(t, true)
}
