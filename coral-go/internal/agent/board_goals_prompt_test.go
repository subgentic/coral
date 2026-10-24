package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #7296 round 2 (Codex Test's finding): an agent is told the board's open goals with what makes each done in the board system prompt it gets at launch, where it is already subscribed and never runs join.
func TestTheBoardSystemPromptListsTheBoardsOpenGoals(t *testing.T) {
	defer SetBoardGoalsBrief(nil)
	plain := BuildBoardSystemPrompt("team", "Developer", "", nil, "")
	assert.NotContains(t, plain, "open goals", "no hook, no goals")

	SetBoardGoalsBrief(func(board string) string {
		if board != "team" {
			return ""
		}
		return "This board's open goals (what the team is working toward):\n  #3 Ship it — done when: Release is out"
	})
	got := BuildBoardSystemPrompt("team", "Developer", "", nil, "")
	assert.Contains(t, got, "#3 Ship it — done when: Release is out")
	assert.Contains(t, got, "Do NOT run coral-board join", "the no-join rule stays")
	assert.Less(t, strings.Index(got, "#3 Ship it"), strings.Index(got, "Do NOT run")+len(got), "inside the board section")
	orch := BuildBoardSystemPrompt("team", "Orchestrator", "", nil, "")
	assert.Contains(t, orch, "#3 Ship it", "an orchestrator too")
	other := BuildBoardSystemPrompt("elsewhere", "Developer", "", nil, "")
	assert.NotContains(t, other, "#3 Ship it", "another board's goals are not shown")
	assert.NotContains(t, BuildBoardSystemPrompt("", "Developer", "base", nil, ""), "open goals", "no board, no goals")
}
