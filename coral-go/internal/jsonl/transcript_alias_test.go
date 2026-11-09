package jsonl

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// After a /clear Claude writes a new transcript file under a new session id while Coral keeps its own id for the agent (#14849): the resolver reads the new file once the alias is told, the old one until the
// new one exists, and never a file that was started before the reset (Security's SHOULD: an id of an older transcript is not the agent's).
func TestAClearedSessionIsReadFromItsNewTranscript(t *testing.T) {
	base := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", base)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	const old, fresh = "aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"
	dir := filepath.Join(base, "-tmp-proj")
	require.NoError(t, os.MkdirAll(dir, 0o755))
	oldFile, newFile := filepath.Join(dir, old+".jsonl"), filepath.Join(dir, fresh+".jsonl")
	require.NoError(t, os.WriteFile(oldFile, []byte("{}\n"), 0o644))
	t.Cleanup(func() { SetTranscriptAlias(old, "", time.Time{}) })
	reset := time.Date(2026, 11, 9, 7, 36, 7, 0, time.UTC)
	stamped := func(at time.Time) []byte {
		return []byte(`{"type":"mode","mode":"normal"}` + "\n" + `{"type":"file-history-snapshot","snapshot":{"timestamp":"` + at.Format(time.RFC3339Nano) + `"}}` + "\n")
	}

	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "no alias: its own file")
	SetTranscriptAlias(old, fresh, reset)
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "the new file is not written yet: the old one")
	require.NoError(t, os.WriteFile(newFile, []byte(`{"type":"mode","mode":"normal"}`+"\n"), 0o644))
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "a file with no stamp yet is not known to be the new one")
	require.NoError(t, os.WriteFile(newFile, stamped(reset.Add(-time.Hour)), 0o644))
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "a transcript started an hour before the reset is somebody else's")
	require.NoError(t, os.WriteFile(newFile, stamped(reset.Add(2*time.Second)), 0o644))
	assert.Equal(t, newFile, resolveClaudeTranscript(old, ""), "a transcript started just after the reset is the live one")
	require.NoError(t, os.WriteFile(newFile, stamped(reset.Add(-10*time.Second)), 0o644))
	assert.Equal(t, newFile, resolveClaudeTranscript(old, ""), "within the slack of the reset (the hook runs a moment after the CLI starts)")
	assert.Equal(t, fresh, TranscriptAlias(old))

	SetTranscriptAlias(old, "not-a-session-id", reset)
	assert.Equal(t, fresh, TranscriptAlias(old), "an id that is not a session id changes nothing")
	SetTranscriptAlias("nope", fresh, reset)
	assert.Empty(t, TranscriptAlias("nope"))
	SetTranscriptAlias(old, "", time.Time{})
	assert.Equal(t, oldFile, resolveClaudeTranscript(old, ""), "ended: its own file again")
}
