package routes

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// An opencode agent's history row has a LABEL for its source (opencode://<id>), not a file. Opened as a path it is a relative one, ./opencode:/<id> in the folder Coral was started from: a file planted
// there must never be read as the row's transcript (Security's #137942).
func TestAFilePlantedAtALabelSourcesRelativePathIsNeverRead(t *testing.T) {
	const id = "11111111-2222-4333-8444-5555555555aa"
	label := agent.OpencodeSourcePrefix + id
	dir := t.TempDir()
	t.Chdir(dir)
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "opencode:"), 0o700))
	planted := filepath.Join(dir, "opencode:", id)
	require.NoError(t, os.WriteFile(planted, []byte(`{"cwd":"/planted/dir","permissionMode":"plan","type":"user","message":{"role":"user","content":"PLANTED-SECRET"}}`+"\n"), 0o600))
	_, err := os.Stat(label)
	require.NoError(t, err, "the label does resolve to the planted file as a path: that is the hazard")

	assert.True(t, agent.IsLabelSource(label))
	assert.False(t, agent.IsLabelSource("/home/u/.claude/projects/x.jsonl"))
	assert.False(t, agent.IsLabelSource(""))

	cwd, mode := transcriptStart(label)
	assert.Empty(t, cwd, "the planted file's working folder is not taken")
	assert.Empty(t, mode)
	assert.Empty(t, nativeResumeID("opencode", label, id))

	h := &SessionsHandler{}
	msgs, why, err := h.loadSessionMessages(context.Background(), store.SessionLineageItem{SessionID: id, AgentType: "opencode", SourceFile: label})
	require.NoError(t, err)
	assert.Empty(t, msgs, "the planted file is not read as the transcript")
	assert.Equal(t, agent.LabelSourceNote, why, "a plain answer, and the label is not printed in it")
	assert.NotContains(t, why, "opencode:")
}
