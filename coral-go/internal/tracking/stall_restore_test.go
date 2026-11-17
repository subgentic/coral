package tracking

import (
	"context"
	"testing"

	"github.com/subgentic/coral/internal/config"
)

// #19315: the dashboard-stall watch reads the state folder from its own goroutine; the restore ConfigureForTest returns must wait for it, or the restore's write of that folder races with the read (found under go test -race in internal/startup, whose server starts the watch).
func TestRestoreWaitsForTheStallWatchBeforeWritingTheStateFolderBack(t *testing.T) {
	prevKey := config.PostHogKey
	config.PostHogKey = "phc_test_key"
	t.Cleanup(func() { config.PostHogKey = prevKey })
	for i := 0; i < 200; i++ {
		restore := ConfigureForTest("", t.TempDir(), "test-install")
		ctx, cancel := context.WithCancel(context.Background())
		WatchDashboardStall(ctx)
		cancel()
		restore()
	}
}
