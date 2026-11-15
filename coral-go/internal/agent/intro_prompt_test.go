package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// A restarted agent posted "@all Hi, I'm ... waiting for a task" about 40 times (#17641): a first join introduces itself with no @all, and a member that has posted on the board before is told not to, to run task list and
// to carry on with its task.
func TestTheStartMessageIntroducesOnlyOnAFirstJoinAndNeverToEveryone(t *testing.T) {
	for _, role := range []string{"Beta Tester", "Orchestrator"} {
		first := BuildBoardActionPromptFor("team", role, "", nil, "", false)
		again := BuildBoardActionPromptFor("team", role, "", nil, "", true)
		assert.NotContains(t, first, "@all <your introduction>", role+": a first join does not post to everyone")
		assert.Contains(t, first, "short introduction", role)
		assert.NotContains(t, again, "short introduction", role+": a returning member does not introduce itself")
		assert.Contains(t, again, "do NOT introduce yourself", role)
		assert.Contains(t, again, "coral-board task list", role)
		assert.NotContains(t, again, "{introduction}", role)
		assert.NotContains(t, first, "{introduction}", role)
	}
	assert.Equal(t, BuildBoardActionPrompt("team", "Beta Tester", "", nil, ""), BuildBoardActionPromptFor("team", "Beta Tester", "", nil, "", false))
	for _, sys := range []string{DefaultWorkerSystemPrompt, DefaultOrchestratorSystemPrompt} {
		assert.False(t, strings.Contains(sys, "@all <your introduction>"), "the system prompt does not tell it to post to @all either")
	}
	custom := BuildBoardActionPromptFor("team", "Beta Tester", "", map[string]string{"default_prompt_worker": "Your own words for {board_name}."}, "", true)
	assert.Equal(t, "Your own words for team.", custom, "a prompt the person wrote is used as it is")
}
