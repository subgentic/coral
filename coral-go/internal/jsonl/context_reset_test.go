package jsonl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #15055: a /compact or /clear writes no usage row, so the card kept the pre-reset percentage until the next reply. ContextReset says a reset came after the newest model turn.

func contextResetOf(t *testing.T, sid string, lines []string) ContextReset {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	project := filepath.Join(dir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644))
	return NewSessionReader().ContextReset(sid, "", at.Claude)
}

const usageTurn = `{"type":"assistant","timestamp":"2026-11-10T04:00:00.000Z","message":{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":3,"cache_read_input_tokens":290000}}}`

func TestContextReset_CompactAfterTurn(t *testing.T) {
	r := contextResetOf(t, "11111111-0000-4000-8000-0000000015a1", []string{
		usageTurn,
		`{"type":"system","subtype":"compact_boundary","timestamp":"2026-11-10T04:05:00.000Z","compactMetadata":{"trigger":"manual","preTokens":290000,"postTokens":15403}}`,
	})
	assert.True(t, r.Reset, "the boundary is newer than the last model turn: its usage is the old context")
	assert.Equal(t, 15403, r.PostTokens)
}

func TestContextReset_CompactWithoutPostTokens(t *testing.T) {
	r := contextResetOf(t, "11111111-0000-4000-8000-0000000015a2", []string{
		usageTurn,
		`{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":670587}}`,
	})
	assert.True(t, r.Reset)
	assert.Zero(t, r.PostTokens, "unknown until the next turn")
}

func TestContextReset_ClearAfterTurn(t *testing.T) {
	r := contextResetOf(t, "11111111-0000-4000-8000-0000000015a3", []string{
		usageTurn,
		`{"type":"user","message":{"content":"<command-name>/clear</command-name>\n <command-message>clear</command-message>\n <command-args></command-args>"}}`,
	})
	assert.True(t, r.Reset)
}

func TestContextReset_NextTurnClearsIt(t *testing.T) {
	r := contextResetOf(t, "11111111-0000-4000-8000-0000000015a4", []string{
		usageTurn,
		`{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":290000}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"back"}],"usage":{"input_tokens":3,"cache_read_input_tokens":16000}}}`,
	})
	assert.False(t, r.Reset, "a model turn after the boundary carries the new size")
}

func TestContextReset_SubagentTurnDoesNotCount(t *testing.T) {
	r := contextResetOf(t, "11111111-0000-4000-8000-0000000015a5", []string{
		usageTurn,
		`{"type":"system","subtype":"compact_boundary","compactMetadata":{"preTokens":290000}}`,
		`{"type":"assistant","isSidechain":true,"message":{"content":[],"usage":{"input_tokens":9}}}`,
	})
	assert.True(t, r.Reset, "a subagent's own turn is not the session's context")
}

func TestContextReset_OtherAgentsAndPlainSessions(t *testing.T) {
	assert.False(t, contextResetOf(t, "11111111-0000-4000-8000-0000000015a6", []string{usageTurn}).Reset)
	assert.False(t, NewSessionReader().ContextReset("11111111-0000-4000-8000-0000000015a7", "", at.Codex).Reset)
}
