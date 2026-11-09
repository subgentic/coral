package routes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The handoff note of the context reset (#14849) is found by the agent session's own upload record: its name, after the request, uploaded by the agent and not by the Operator.
func TestLatestUploadNamedFindsTheAgentsOwnNoteAfterTheRequest(t *testing.T) {
	dir := t.TempDir()
	const session = "aaaaaaaa-6610-4000-8000-000000000001"
	up := filepath.Join(dir, "artifacts", "uploads", session)
	require.NoError(t, os.MkdirAll(up, 0o755))
	write := func(digestChar, name, uploadedBy string, at time.Time) string {
		digest := strings.Repeat(digestChar, 64)
		rec := agentUploadRecord{agentArtifactMeta: agentArtifactMeta{Name: name, Digest: digest}, CreatedAt: at.UTC().Format(time.RFC3339Nano), UploadedBy: uploadedBy}
		raw, err := json.Marshal(rec)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(up, digest+".json"), raw, 0o644))
		return digest
	}
	asked := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	assert.Empty(t, LatestUploadNamed(dir, session, "handoff.md", asked), "nothing uploaded")
	write("a", "handoff.md", "", asked.Add(-time.Hour))
	assert.Empty(t, LatestUploadNamed(dir, session, "handoff.md", asked), "a note from before the request is an old one")
	write("b", "notes.md", "", asked.Add(time.Minute))
	assert.Empty(t, LatestUploadNamed(dir, session, "handoff.md", asked), "another name is not the note")
	write("c", "handoff.md", "owner", asked.Add(time.Minute))
	assert.Empty(t, LatestUploadNamed(dir, session, "handoff.md", asked), "a file the Operator pasted is not the agent's note")
	first := write("d", "handoff.md", "", asked.Add(2*time.Minute))
	assert.Equal(t, first, LatestUploadNamed(dir, session, "handoff.md", asked))
	newest := write("e", "handoff.md", "", asked.Add(5*time.Minute))
	assert.Equal(t, newest, LatestUploadNamed(dir, session, "handoff.md", asked), "the newest note")
	assert.Empty(t, LatestUploadNamed(dir, "bbbbbbbb-6610-4000-8000-000000000002", "handoff.md", asked), "another session's folder is never read")
	assert.Empty(t, LatestUploadNamed(dir, "../x", "handoff.md", asked), "an unsafe session id reads nothing")
	assert.Empty(t, LatestUploadNamed("", session, "handoff.md", asked))
}
