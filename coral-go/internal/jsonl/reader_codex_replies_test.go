package jsonl

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7419: a real Codex session (captured in an isolated home and scrubbed, byte lengths kept): two turns, each with commentary, a tool call and a final answer. The reader hands the chat view each reply as
// its own assistant message with phase final_answer, and the commentary with phase commentary, in order: the folding of a reply into a steps group is the chat view's rule (chat_messages.js), never
// the reader's, so a reply is not lost or merged here.
func TestReadAllMessages_CodexRepliesAreSeparateMessagesWithTheirPhase(t *testing.T) {
	dir := t.TempDir()
	sessionID := "019e9db7-58df-7082-a954-7305c01b1490"
	codexHome := filepath.Join(dir, ".codex")
	sessionDir := filepath.Join(codexHome, "sessions", "2026", "10", "25")
	require.NoError(t, os.MkdirAll(sessionDir, 0o755))
	t.Setenv("CODEX_HOME", codexHome)
	fixture, err := os.ReadFile(filepath.Join("testdata", "codex_replies_7419.jsonl"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(sessionDir, "rollout-2026-10-25T04-56-00-"+sessionID+".jsonl"), fixture, 0o644))

	msgs, _ := NewSessionReader().ReadAllMessagesContext(context.Background(), sessionID, "", "codex")
	type row struct{ kind, phase, text string }
	var got []row
	for _, m := range msgs {
		if m["type"] != "assistant" {
			continue
		}
		text, _ := m["text"].(string)
		phase, _ := m["phase"].(string)
		if text != "" {
			got = append(got, row{"assistant", phase, text})
		}
	}
	want := []row{
		{"assistant", "commentary", "I’ll introduce myself on the board, then stop and await the Operator’s"},
		{"assistant", "commentary", "I’ll read `fixture.txt` and report its contents."},
		{"assistant", "final_answer", "REPLY7419-ONE: The file contains `fixture`."},
		{"assistant", "commentary", "I’ll post the requested message and check the result."},
		{"assistant", "final_answer", "REPLY7419-TWO: Message #2 was posted to board `b-qh4cu5v6l5`."},
	}
	require.Len(t, got, len(want), "%v", got)
	for i := range want {
		assert.Equal(t, want[i].phase, got[i].phase, "message %d", i)
		assert.True(t, strings.HasPrefix(got[i].text, want[i].text[:30]), "message %d: %q", i, got[i].text)
	}
	tools := 0
	for _, m := range msgs {
		if m["type"] == "tool_result" {
			tools++
		}
	}
	assert.Equal(t, 3, tools, "all three tool results are kept")
}
