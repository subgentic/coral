package agent

import (
	"strings"
	"testing"
)

// #15167 (Beta walk 6, M8): the Orchestrator asked "What should the team build?" although the Operator had just given the goal: the goal reaches the board a few seconds AFTER the agents start (the dashboard posts it
// once the team exists), so the Orchestrator's start prompt tells it to read the board and its tasks before it asks.
func TestOrchestratorReadsTheBoardForTheFirstTaskBeforeAsking(t *testing.T) {
	p := DefaultOrchestratorActionPrompt
	for _, want := range []string{"just launched", "first task from the Operator", "coral-board read", "coral-board task list", "never ask twice"} {
		if !strings.Contains(p, want) {
			t.Errorf("the Orchestrator's prompt should say %q before asking what to build", want)
		}
	}
}
