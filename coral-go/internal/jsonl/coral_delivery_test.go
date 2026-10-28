package jsonl

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10046: a turn Coral typed into an agent (the unread-messages nudge, a task notice, the health check, a stop-hook block) is not what a person asked for. The transcript records it as a user
// turn, and a session's first prompt (and the goal made from its requests) took the nudge for the request.
func TestIsCoralDeliveryKnowsWhatCoralTypesIntoAnAgent(t *testing.T) {
	for _, text := range []string{
		"You have 1 unread message on the message board. Run 'coral-board read' to see them.",
		"You have 12 unread messages on the message board. Run 'coral-board read' to see them.",
		"you have 3 UNREAD MESSAGES on the message board",
		"  You have 1 unread message on the message board. Run 'coral-board read'.\n",
		"@QA Engineer You have 1 unread message on the message board. Run 'coral-board read' to see them.",
		"/plan You have 1 unread message on the message board.",
		"You have tasks available. Run 'coral-board task list'.",
		"You have a new task in Coral (#42: Fix the thing)",
		"[Task #12 (high) available] do it",
		"[New Task #9 (low)] @notify-all something",
		"@notify-all [New Task #9 (low)] something",
		"[Wait resolved] the commit landed",
		"[Coral health check] Team health check for x: 2 unread messages",
		"[Coral] No activity on #9841 for 20 minutes.",
		"[Coral UI panel request p-1] open the file",
		"Stop hook feedback:\nNew board messages",
		"<pasted_content id=\"1\">You have 2 unread messages on the message board. Run 'coral-board read' to see them.</pasted_content>",
	} {
		assert.True(t, IsCoralDelivery(text), text)
	}
	for _, text := range []string{
		"",
		"Build the dashboard",
		"Review the unread messages in my inbox and summarise them",
		"You have a great idea: use a map",
		"You have to fix the bug in main.go",
		"Please read [Task #12] and answer",
		"Message number 14",
		"What does the Stop hook do?",
		"I got: Stop hook feedback: new messages, why?",
		"<pasted_content id=\"1\">fix the failing test</pasted_content>",
	} {
		assert.False(t, IsCoralDelivery(text), text)
	}
}

func TestFirstUserPromptSkipsWhatCoralTypedIntoTheAgent(t *testing.T) {
	dir := t.TempDir()
	sessionID := "00000000-0000-4000-8000-000000010046"
	projectDir := filepath.Join(dir, "project")
	require.NoError(t, os.MkdirAll(projectDir, 0o755))
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	// an Orchestrator launched with no prompt: the first user turn in its transcript is Coral's own nudge
	entries := `{"type":"user","message":{"content":"You have 1 unread message on the message board. Run 'coral-board read' to see them."}}
{"type":"assistant","message":{"content":"Reading the board."}}
{"type":"user","message":{"content":"[Task #7 (high) available] build it"}}
{"type":"user","message":{"content":"  Plan the release  "}}
{"type":"user","message":{"content":"You have 2 unread messages on the message board."}}
`
	require.NoError(t, os.WriteFile(filepath.Join(projectDir, sessionID+".jsonl"), []byte(entries), 0o644))
	reader := NewSessionReader()
	assert.Equal(t, "Plan the release", reader.FirstUserPrompt(sessionID, "", "claude"), "the first thing a person asked, not Coral's nudge")

	only := "00000000-0000-4000-8000-000000010047"
	require.NoError(t, os.WriteFile(filepath.Join(projectDir, only+".jsonl"), []byte(`{"type":"user","message":{"content":"You have 1 unread message on the message board."}}`+"\n"), 0o644))
	assert.Equal(t, "", NewSessionReader().FirstUserPrompt(only, "", "claude"), "a session nobody has asked anything has no first prompt")
}
