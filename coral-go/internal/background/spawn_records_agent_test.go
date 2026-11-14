package background

import (
	"context"
	"testing"
	"time"

	"github.com/subgentic/coral/internal/tmux"
)

// A job run's agent is started through the runtime's SpawnAgent, which types the launch line itself. The agent's process must be recorded from it (as the dashboard's launch does):
// without the record the automated-input gate refuses every send to the terminal as "the agent's process is not recorded", so a job's first prompt was never typed and the run sat at an
// empty prompt as "Running" (#17250, walk 58).
func TestSpawnAgentRecordsTheAgentsProcessSoItsFirstPromptCanBeTyped(t *testing.T) {
	skipIfNoPTY(t)
	rt := newTestPTYRuntime()
	const name = "claude-" + testUUID
	ctx := context.Background()
	if err := rt.SpawnAgent(ctx, name, t.TempDir(), "", "sleep 30; true"); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	t.Cleanup(func() { rt.KillAgent(ctx, name); tmux.ForgetAgentProc(name) })
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := tmux.AdoptedAgentProc(name); ok {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the agent's process was never recorded after SpawnAgent: a prompt typed to it would be refused as 'not recorded'")
}
