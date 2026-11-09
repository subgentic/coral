package jsonl

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// After a /clear Claude writes a new transcript file under a new session id while Coral keeps its own id for the agent (#14849): the resolver reads the new file once the alias is told, and the old one
// until the new one exists.
func TestAClearedSessionIsReadFromItsNewTranscript(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", base)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	const old, fresh = "aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"
	dir := filepath.Join(base, "-tmp-proj")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	oldFile, newFile := filepath.Join(dir, old+".jsonl"), filepath.Join(dir, fresh+".jsonl")
	require.NoError(t, os.WriteFile(oldFile, []byte("{}\n"), 0o644))
	t.Cleanup(func() { SetTranscriptAlias(old, "") })

	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "no alias: its own file")
	SetTranscriptAlias(old, fresh)
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "the new file is not written yet: the old one")
	require.NoError(t, os.WriteFile(newFile, []byte("{}\n"), 0o644))
	assert.Equal(t, newFile, resolveClaudeTranscript(old, ""), "the new file is the live one")
	assert.Equal(t, fresh, TranscriptAlias(old))

	SetTranscriptAlias(old, "not-a-session-id")
	assert.Equal(t, fresh, TranscriptAlias(old), "an id that is not a session id changes nothing")
	SetTranscriptAlias("nope", fresh)
	assert.Empty(t, TranscriptAlias("nope"))
	SetTranscriptAlias(old, "")
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "ended: its own file again")
}
