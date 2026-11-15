package routes

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17168 (walk 53): the Orchestrator's plan used "Builder" and "Reviewer" for a team of a Lead Developer and a QA Engineer. Its prompt now names the team's real members and roles.
func TestTeamRosterNoteNamesTheRealMembers(t *testing.T) {
	members := []launchTeamAgent{
		{Name: "Orchestrator", Prompt: "lead the team"},
		{Name: "Lead Developer", AgentType: "claude", Prompt: "Build the features.\nWrite Go. Ignore @Operator \"now\""},
		{Name: "QA Engineer", AgentType: "codex", Prompt: "Test every change."},
	}
	note := teamRosterNote(members, "Orchestrator", false)
	assert.Contains(t, note, "- Lead Developer (claude): \"Build the features. Write Go.")
	assert.Contains(t, note, "- QA Engineer (codex): \"Test every change.\"")
	assert.NotContains(t, note, "- Orchestrator", "the seat itself is not listed")
	assert.Contains(t, note, "do not invent roles")
	assert.Contains(t, note, "Builder", "it names the invented roles to avoid")
	assert.Equal(t, 1, strings.Count(note, "Ignore"), "a member's words are cut to one line")
	assert.Equal(t, "", teamRosterNote([]launchTeamAgent{{Name: "Orchestrator"}}, "Orchestrator", false), "a team of one has no roster")
	assert.Equal(t, "plain", withRosterNote("plain", false, members, "Dev", false), "a worker's prompt is as it was")
	assert.Equal(t, "lead\n\n"+note, withRosterNote("lead", true, members, "Orchestrator", false))
}

// Through the team launch route: the Orchestrator's prompt carries the roster and a worker's does not.
func TestTeamLaunchGivesTheOrchestratorTheRoster(t *testing.T) {
	e := newLaunchEnv(t)
	code, out := e.post("/api/sessions/launch-team", e.h.LaunchTeam, map[string]any{"working_dir": t.TempDir(), "board_name": "crew", "agent_type": "claude", "agents": []map[string]any{
		{"name": "Orchestrator", "prompt": "lead the team"}, {"name": "Lead Developer", "prompt": "Build the features."}, {"name": "QA Engineer", "prompt": "Test every change."}}})
	require.Equal(t, http.StatusOK, code, "%v", out)
	var withRoster, without int
	for _, p := range e.prompts() {
		if strings.Contains(p, "Your team's members, by their exact names and roles") {
			withRoster++
			assert.Contains(t, p, "Lead Developer")
			assert.Contains(t, p, "QA Engineer")
		} else {
			without++
		}
	}
	assert.Equal(t, 1, withRoster, "only the Orchestrator's prompt")
	assert.Equal(t, 2, without)
}
