package machinehealth

import (
	"context"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

// This test process is a tree of at least itself: it has usage, and a bound of zero processes fails closed.
func TestTreeUsageOfThisProcess(t *testing.T) {
	cpu, rss, procs, ok := TreeUsage(context.Background(), os.Getpid(), 4096)
	assert.True(t, ok)
	assert.GreaterOrEqual(t, procs, 1)
	assert.Greater(t, rss, uint64(0))
	assert.GreaterOrEqual(t, cpu, 0.0)

	_, _, _, ok = TreeUsage(context.Background(), os.Getpid(), 0)
	assert.False(t, ok, "a tree over the bound is not read: busy, never quiet")
	_, _, _, ok = TreeUsage(context.Background(), 0, 4096)
	assert.False(t, ok, "no root")
	_, _, _, ok = TreeUsage(context.Background(), -5, 4096)
	assert.False(t, ok, "no root")
}
