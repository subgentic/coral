package agent

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10163 (Beta #10140): an Orchestrator launched with no prompt has Coral's own task nudge as its first user turn; History and the Inbox's All chats titled the chat with it
// ("[Task #1 available] Run coral-board task claim 1..."). A chat's title is the first thing a person typed, so what Coral typed into the agent is skipped for every CLI.
func TestFirstUserMessageSkipsWhatCoralTypedIntoTheAgent(t *testing.T) {
	base := t.TempDir()
	writeLines(t, filepath.Join(base, "p", "00000000-0000-4000-8000-000000010163.jsonl"),
		`{"type":"user","timestamp":"2026-10-28T00:00:00Z","message":{"role":"user","content":"[Task #1 available] Run 'coral-board task claim 1' to claim it when your current task is done."}}`,
		`{"type":"user","timestamp":"2026-10-28T00:00:01Z","message":{"role":"user","content":"You have 2 unread messages on the message board. Run 'coral-board read' to see them."}}`,
		`{"type":"user","timestamp":"2026-10-28T00:00:02Z","message":{"role":"user","content":"Plan the release"}}`,
		`{"type":"assistant","timestamp":"2026-10-28T00:00:03Z","message":{"content":[{"type":"text","text":"ok"}]}}`)
	got, err := (&ClaudeAgent{}).ExtractSessions(base, nil)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "Plan the release", got[0].FirstUserMessage, "the first thing a person typed, not Coral's nudge")

	only := t.TempDir()
	writeLines(t, filepath.Join(only, "p", "00000000-0000-4000-8000-000000010164.jsonl"),
		`{"type":"user","timestamp":"2026-10-28T00:00:00Z","message":{"role":"user","content":"[Task #1 available] Run 'coral-board task claim 1'"}}`,
		`{"type":"assistant","timestamp":"2026-10-28T00:00:03Z","message":{"content":[{"type":"text","text":"ok"}]}}`)
	got, err = (&ClaudeAgent{}).ExtractSessions(only, nil)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "", got[0].FirstUserMessage, "a chat nobody has typed in has no title from Coral's nudge")
}
