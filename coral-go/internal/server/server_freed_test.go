package server

import (
	"runtime"
	"testing"
	"weak"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
)

// #20892: process-wide tables keyed by data folder (the artifact stores, the Dropbox backup workers, the artifact revision stores) kept every server a test built, with its board store, routers, parsed
// index template and handlers: 342 of them were still in memory at the end of the package's run, about 1.5 MB each, which with the bundle builds of static_version_test took the binary past its 2048 MiB
// guard. A server that was closed is dropped by everything outside it.
//
// Two tests, in this order: a server is only free once its own test has ended (its cleanups hold it until then), so the first builds two and the second looks. The second server is built so that
// the single-slot hooks every server sets are overwritten; only the first is asserted, because the latest one may be held by them.
var closedServers []weak.Pointer[Server]

func TestServerTestsBuildTwoServersAndCloseThem(t *testing.T) {
	for i := 0; i < 2; i++ {
		cfg := newE2EConfig(t, t.TempDir())
		db, err := storetest.Open(t, cfg.DBPath)
		require.NoError(t, err)
		t.Cleanup(func() { db.Close() })
		stack := newTermStack(t)
		srv := newTestServer(t, cfg, db, stack.backend, stack.terminal)
		if i == 0 {
			closedServers = append(closedServers, weak.Make(srv))
		}
	}
}

func TestAClosedServerIsNotHeldByTheProcess(t *testing.T) {
	if len(closedServers) == 0 {
		t.Skip("the test that builds the servers did not run first (a filter or a shuffle)")
	}
	for i := 0; i < 3; i++ {
		runtime.GC()
	}
	for i, w := range closedServers {
		require.True(t, w.Value() == nil, "closed server %d is still reachable from a package variable of the process: every server a test builds stays in memory to the end of the run", i)
	}
}
