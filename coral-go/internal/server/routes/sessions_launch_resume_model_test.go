package routes

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
)

// #15293 (walk 17 M8): a killed agent resumed from the Resume dialog came back on "CLI default": the dialog names no model, and the launch used the Settings default. A resume that names neither a model nor a
// thinking level starts at what the conversation last ran at, read from its transcript.
func TestAResumeNamingNoModelStartsAtTheOneTheConversationRan(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", dir)
	sid := "00000000-0000-4000-8000-000000015293"
	path := filepath.Join(dir, "x", sid+".jsonl")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
	require.NoError(t, os.WriteFile(path, []byte(
		`{"sessionId":"`+sid+`","type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-11-10T00:00:00Z"}`+"\n"+
			`{"sessionId":"`+sid+`","type":"assistant","effort":"medium","message":{"model":"claude-sonnet-5-5","role":"assistant","content":[]},"timestamp":"2026-11-10T00:00:01Z"}`+"\n"), 0o600))
	h := &SessionsHandler{jsonl: jsonl.NewSessionReader()}

	model, thinking := h.resumedRunWith("claude", sid, t.TempDir())
	assert.Equal(t, "claude-sonnet-5-5", model, "the model the conversation ran on")
	assert.Equal(t, "medium", thinking, "and its thinking level")

	model, thinking = h.resumedRunWith("codex", sid, t.TempDir())
	assert.Empty(t, model+thinking, "only Claude's transcript is read here")
	model, thinking = h.resumedRunWith("claude", "00000000-0000-4000-8000-0000000000ff", t.TempDir())
	assert.Empty(t, model+thinking, "a conversation with no transcript starts as it did before")
}
