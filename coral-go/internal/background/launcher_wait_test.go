package background

import (
	"testing"

	"github.com/subgentic/coral/internal/store"
)

// newTestLauncher is NewAgentLauncher whose version probes are waited for when the test ends, before the store it writes to is closed and the folders it runs in are removed (#11354: a probe that outlived
// its test wrote to a closed database, and the removal of the temp folder failed "directory not empty", 2 to 3 runs in 100).
func newTestLauncher(t *testing.T, runtime AgentRuntime, sessDB *store.SessionStore, port int) *AgentLauncher {
	t.Helper()
	l := NewAgentLauncher(runtime, sessDB, port)
	t.Cleanup(l.Wait)
	return l
}
