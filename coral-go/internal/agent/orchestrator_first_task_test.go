package agent

import (
	"strings"
	"testing"
)

// #15167 (Beta walk 6, M8): the Orchestrator asked "What should the team build?" although the Operator had just given the goal: the goal reaches the board a few seconds AFTER the agents start (the dashboard posts it
// once the team exists), so the Orchestrator's start prompt tells it to read the board and its tasks before it asks, and once more if the board has no task yet (true for any launch, not only the dashboard's New team flow). This pins the WORDING of the prompt, not what an Orchestrator does with it (QA's SHOULD on #15167, #15355).
func TestOrchestratorPromptWordingSaysToReadTheBoardForTheFirstTaskBeforeAsking(t *testing.T) {
	p := DefaultOrchestratorActionPrompt
	for _, want := range []string{"coral-board read", "coral-board task list", "never ask twice", "If the board has no task yet, read it again once before asking what to build"} {
		if !strings.Contains(p, want) {
			t.Errorf("the Orchestrator's prompt should say %q before asking what to build", want)
		}
	}
}
