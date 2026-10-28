package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #10291 (Desktop pass 25): Resume offered Coral's own folder, not the folder the past chat ran in, for a chat Coral had no live row for. The transcript says where it ran (Claude's entries carry cwd,
// Codex's session_meta has it in its payload): resume-info reads it, says whether the folder still exists, and a live row of the session still wins.
func TestResumeInfoSaysWhereThePastChatRan(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	dir := t.TempDir() // a folder that exists
	gone := filepath.Join(dir, "removed")
	files := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(files, name)
		require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
		return p
	}
	index := func(id, typ, file string) {
		stamp := "2026-10-20T10:00:00Z"
		require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: typ, SourceFile: file, LastTimestamp: &stamp, FirstTimestamp: &stamp, MessageCount: 2, FileMtime: 1}))
	}
	index("claude-ran", "claude", write("c.jsonl", `{"type":"summary","summary":"x"}`+"\n"+`{"type":"user","cwd":`+quote(dir)+`,"message":{"content":"hi"}}`+"\n"))
	index("codex-ran", "codex", write("rollout-x.jsonl", `{"type":"session_meta","payload":{"id":"x","cwd":`+quote(dir)+`}}`+"\n"))
	index("claude-removed", "claude", write("r.jsonl", `{"type":"user","cwd":`+quote(gone)+`}`+"\n"))
	index("claude-none", "claude", write("n.jsonl", `{"type":"user","message":{"content":"hi"}}`+"\n"))
	index("claude-relative", "claude", write("rel.jsonl", `{"type":"user","cwd":"relative/dir"}`+"\n"))
	index("claude-missing-file", "claude", filepath.Join(files, "nothing.jsonl"))

	r := chi.NewRouter()
	r.Get("/api/sessions/history/{sessionID}/resume-info", h.GetResumeInfo)
	info := func(id string) map[string]any {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/history/"+id+"/resume-info", nil))
		require.Equal(t, 200, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	got := info("claude-ran")
	assert.Equal(t, dir, got["working_dir"], "Claude's transcript says where it ran")
	assert.Equal(t, "session", got["working_dir_from"])
	assert.Equal(t, true, got["working_dir_exists"])
	assert.Equal(t, dir, info("codex-ran")["working_dir"], "Codex's session_meta payload too")
	got = info("claude-removed")
	assert.Equal(t, gone, got["working_dir"])
	assert.Equal(t, false, got["working_dir_exists"], "a folder that is gone says so")
	for _, id := range []string{"claude-none", "claude-relative", "claude-missing-file"} {
		assert.NotContains(t, info(id), "working_dir", id+": no folder is guessed")
	}

	// a live row of the session is its own word
	live := t.TempDir()
	require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "claude-ran", AgentType: "claude", AgentName: "ran", WorkingDir: live}))
	assert.Equal(t, live, info("claude-ran")["working_dir"], "a live row wins")
}

func quote(s string) string { b, _ := json.Marshal(s); return string(b) }
