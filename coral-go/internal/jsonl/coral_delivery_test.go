package jsonl

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10046: the first prompt skips what Coral typed into the agent (the delivery patterns are agent.IsCoralDelivery).
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
