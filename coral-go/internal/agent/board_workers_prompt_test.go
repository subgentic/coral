package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// Mock v3 idea 2 (#21467): the team's approved workers are written into an Orchestrator's board system prompt at every start, and into no other role's.
func TestTheBoardSystemPromptListsTheApprovedWorkersForAnOrchestratorOnly(t *testing.T) {
	defer SetBoardWorkersBrief(nil)
	assert.NotContains(t, BuildBoardSystemPrompt("team", "Orchestrator", "", nil, ""), "Workers approved for this team", "no hook, no list")

	SetBoardWorkersBrief(func(board string) string {
		if board != "team" {
			return ""
		}
		return "Workers approved for this team:\n  Worker  for code tasks  (Claude · Sonnet)"
	})
	orch := BuildBoardSystemPrompt("team", "Orchestrator", "", nil, "")
	assert.Contains(t, orch, "Workers approved for this team:")
	assert.Contains(t, orch, "Worker  for code tasks")
	assert.NotContains(t, BuildBoardSystemPrompt("team", "Developer", "", nil, ""), "Workers approved for this team", "a worker is not told the list")
	assert.NotContains(t, BuildBoardSystemPrompt("elsewhere", "Orchestrator", "", nil, ""), "Workers approved for this team", "another team's list is not shown")
}
