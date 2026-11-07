package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #14133: a worker that restarts or wakes finds its own queue; it does not introduce itself and wait for the Orchestrator to say again what is already assigned to it.

func TestWorkerPromptsSendAnAgentToItsOwnQueueAfterTheIntroduction(t *testing.T) {
	for name, p := range map[string]string{"system": DefaultWorkerSystemPrompt, "action": DefaultWorkerActionPrompt} {
		assert.Contains(t, p, "coral-board task list --mine", name+": the command that lists its own tasks")
		assert.Contains(t, p, "in progress first", name)
		assert.Contains(t, p, "resume it", name+": the in-progress task comes back from its thread and worktree")
		assert.Contains(t, p, "its thread", name)
		assert.Contains(t, p, "worktree", name)
		assert.Contains(t, p, "coral-board task claim", name+": otherwise the next assigned one")
		assert.Contains(t, p, "Wait only when you have none", name)
		assert.NotContains(t, p, "then STOP and wait", name+": the old unconditional wait")
		assert.NotContains(t, p, "Do not start any actions", name+": the old action text forbade the work")
		assert.Contains(t, p, "do NOT poll", name+": the no-polling rule stays")
	}
}

func TestWorkerStartStepsPutTheQueueBeforeTheWait(t *testing.T) {
	i := strings.Index(WorkerStartSteps, "task list --mine")
	j := strings.Index(WorkerStartSteps, "Wait only")
	assert.True(t, i >= 0 && j > i, "list your tasks first, wait last")
	// the orchestrator's own prompts are not a worker's: they keep their own start
	assert.NotContains(t, DefaultOrchestratorActionPrompt, "task list --mine")
}

func TestABoardWorkerGetsTheQueueStepsFromTheBuiltPrompts(t *testing.T) {
	sys := BuildBoardSystemPrompt("team", "Developer", "", nil, "claude")
	act := BuildBoardActionPrompt("team", "Developer", "", nil, "claude")
	assert.Contains(t, sys, "coral-board task list --mine")
	assert.Contains(t, act, "coral-board task list --mine")
	gem := BuildBoardActionPrompt("team", "Developer", "", nil, "gemini")
	assert.Contains(t, gem, "task list --mine", "the CLI name is swapped, the step is kept")
}
