package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// An opencode agent's history row has a LABEL for its source (opencode://<id>), not a file. Opened as a path it is a relative one, ./opencode:/<id> in the folder Coral was started from: a file planted
// there must never be read as the row's transcript (Security's #137942).
func TestAFilePlantedAtALabelSourcesRelativePathIsNeverRead(t *testing.T) {
	const id = "11111111-2222-4333-8444-5555555555aa"
	label := agent.OpencodeSourcePrefix + id
	dir := t.TempDir()
	t.Chdir(dir)
	plantAtLabelPath(t, dir, id, label, func(p string) {
		require.NoError(t, os.WriteFile(p, []byte(`{"cwd":"/planted/dir","permissionMode":"plan","type":"user","message":{"role":"user","content":"PLANTED-SECRET"}}`+"\n"), 0o600))
	})

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

// Chat search reads the files of the indexed sessions it shortlists: a label source is never one, whatever a planted file at its relative path holds.
func TestChatSearchNeverReadsAFilePlantedAtALabelSourcesRelativePath(t *testing.T) {
	db, ss, bs, _, cleanup := setupChatSearchTestEnv(t)
	defer cleanup()
	ctx := context.Background()
	const id = "11111111-2222-4333-8444-5555555555bb"
	label := agent.OpencodeSourcePrefix + id
	cwd := t.TempDir()
	t.Chdir(cwd)
	plantAtLabelPath(t, cwd, id, label, func(p string) {
		writeClaudeJSONLTranscript(t, p, []map[string]any{
			{"type": "user", "timestamp": "2026-09-30T10:00:00Z", "message": map[string]any{"content": "quokka PLANTED-MARKER"}},
		})
	})
	// the row is typed as a transcript-reading agent so that, without the guard, the planted file WOULD be parsed
	ts := "2026-09-30T10:00:00Z"
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: label, LastTimestamp: &ts, DisplaySummary: "quokka parser"}))
	require.NoError(t, ss.UpsertFTS(ctx, id, "quokka parser"))

	handler := NewHistoryHandler(db, &config.Config{}, bs)
	w := httptest.NewRecorder()
	handler.SearchChats(w, httptest.NewRequest("GET", "/api/sessions/history/search?q=quokka&type=agent", nil))
	require.Equal(t, http.StatusOK, w.Code)
	assert.NotContains(t, w.Body.String(), "PLANTED-MARKER", "the planted file was read as the row's transcript")
}

// plantAtLabelPath plants a file where a label source (opencode://<id>) would lead if it were opened as a relative path from dir, and checks what the label then
// resolves to (#477). On macOS and Linux that is ./opencode:/<id>, a folder named "opencode:" and the file in it: the label does resolve to the planted file, which is
// the hazard the guard is for. On Windows a folder name cannot hold a colon, and opencode://<id> is no valid path at all ("the filename ... syntax is incorrect"), so
// nothing can be planted there; the nearest a process can plant is a file named opencode with a stream named <id> (opencode:<id>). That is planted, and the test checks
// that the label still resolves to nothing, then runs the same guard checks: the test means the same on every OS and is never skipped.
func plantAtLabelPath(t *testing.T, dir, id, label string, write func(path string)) {
	t.Helper()
	if runtime.GOOS == "windows" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "opencode"), nil, 0o600))
		write(filepath.Join(dir, "opencode:"+id)) // the file opencode's stream <id>
		_, err := os.Stat(label)
		require.Error(t, err, "on Windows the label is no path: it leads to nothing, planted stream or not")
		return
	}
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "opencode:"), 0o700))
	write(filepath.Join(dir, "opencode:", id))
	_, err := os.Stat(label)
	require.NoError(t, err, "the label does resolve to the planted file as a path: that is the hazard")
}
