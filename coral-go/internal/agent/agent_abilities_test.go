package agent

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
)

// #17622: an Orchestrator's system prompt carries the "What you can do on this team" section, built every time the command is (a launch, a restart, a wake), so a later change to a setting is in the next one; no other
// role's prompt, no prompt without a board and no build without the hook changes.
func TestAnOrchestratorsSystemPromptCarriesTheAbilitiesSection(t *testing.T) {
	defer SetBoardAbilities(nil)
	base := BuildBoardSystemPrompt("team", "Orchestrator", "", nil, "")
	p := LaunchParams{BoardName: "team", Role: "Orchestrator"}
	assert.Equal(t, base, withBoardAbilities(base, p, "claude"), "no hook, no section")

	var seen LaunchParams
	var seenType string
	SetBoardAbilities(func(p LaunchParams, agentType string) string {
		seen, seenType = p, agentType
		return "What you can do on this team:\n- X"
	})
	got := withBoardAbilities(base, p, "codex")
	assert.Equal(t, base+"\n\nWhat you can do on this team:\n- X", got, "after the board prompt, in one block")
	assert.Equal(t, "codex", seenType, "the builder says its own type")
	assert.Equal(t, "team", seen.BoardName)
	worker := BuildBoardSystemPrompt("team", "Developer", "", nil, "")
	assert.Equal(t, worker, withBoardAbilities(worker, LaunchParams{BoardName: "team", Role: "Developer"}, "claude"), "a worker's prompt is as it was")
	assert.Equal(t, "base", withBoardAbilities("base", LaunchParams{Role: "Orchestrator"}, "claude"), "no board, no section")
	SetBoardAbilities(func(LaunchParams, string) string { return "" })
	assert.Equal(t, base, withBoardAbilities(base, p, "claude"), "a hook with nothing to say adds nothing")
}

var quotedPath = regexp.MustCompile(`(/[^\s'"]+\.(?:json|md|txt))`)

// commandAndFiles is a launch command with the contents of the prompt files it reads (`cat '<file>'`, or a `--settings <file>`), which is where each agent's system prompt is.
func commandAndFiles(cmd string) string {
	out := cmd
	for _, m := range quotedPath.FindAllStringSubmatch(cmd, -1) {
		if b, err := os.ReadFile(m[1]); err == nil {
			out += "\n" + string(b)
		}
	}
	return out
}

// Through each agent's own command builder: the Orchestrator's launch command has the section and a worker's has not.
func TestEveryAgentTypesOrchestratorCommandCarriesTheSection(t *testing.T) {
	defer SetBoardAbilities(nil)
	SetBoardAbilities(func(LaunchParams, string) string { return "ABILITIES-SECTION-17622" })
	for name, build := range map[string]func(LaunchParams) (string, error){
		"claude": func(p LaunchParams) (string, error) { return (&ClaudeAgent{}).LaunchCommand(p) },
		"codex":  func(p LaunchParams) (string, error) { return (&CodexAgent{}).LaunchCommand(p) },
		"agy":    func(p LaunchParams) (string, error) { return (&AgyAgent{}).LaunchCommand(p) },
		"pi":     func(p LaunchParams) (string, error) { return (&PiAgent{}).LaunchCommand(p) },
	} {
		orch, err := build(LaunchParams{WorkingDir: t.TempDir(), BoardName: "team", Role: "Orchestrator", SessionName: "s-" + name, CoralDir: t.TempDir()})
		assert.NoError(t, err, name)
		worker, err := build(LaunchParams{WorkingDir: t.TempDir(), BoardName: "team", Role: "Developer", SessionName: "s-" + name, CoralDir: t.TempDir()})
		assert.NoError(t, err, name)
		assert.Contains(t, commandAndFiles(orch), "ABILITIES-SECTION-17622", name+": the Orchestrator's command")
		assert.NotContains(t, commandAndFiles(worker), "ABILITIES-SECTION-17622", name+": a worker's command")
	}
}

// Hermes is told its system prompt in its first message (#17662): the Orchestrator's carries the section, a worker's does not.
func TestHermesFirstMessageCarriesTheSectionForAnOrchestratorOnly(t *testing.T) {
	defer SetBoardAbilities(nil)
	SetBoardAbilities(func(LaunchParams, string) string { return "ABILITIES-SECTION-17622" })
	assert.Contains(t, hermesFirstMessage(LaunchParams{BoardName: "team", Role: "Orchestrator"}), "ABILITIES-SECTION-17622")
	assert.NotContains(t, hermesFirstMessage(LaunchParams{BoardName: "team", Role: "Developer"}), "ABILITIES-SECTION-17622")
}
