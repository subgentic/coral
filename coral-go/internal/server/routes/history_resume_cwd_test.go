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

// #10487 (SAFETY, #10454's report): Resume decided the mode by itself: a Plan or Default chat was resumed in the saved default (Auto). resume-info says the mode the chat ran in: the recorded mode of
// its live row, else the one its transcript starts with (Claude's entries carry permissionMode), never a mode its CLI lacks; with none recorded it says nothing and the saved default stays.
func TestResumeInfoSaysTheModeTheChatRanIn(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	dir, files := t.TempDir(), t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(files, name)
		require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
		return p
	}
	index := func(id, typ, file string) {
		stamp := "2026-10-20T10:00:00Z"
		require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: typ, SourceFile: file, LastTimestamp: &stamp, FirstTimestamp: &stamp, MessageCount: 2, FileMtime: 1}))
	}
	entry := func(mode string) string {
		return `{"type":"user","cwd":` + quote(dir) + `,"permissionMode":` + quote(mode) + `,"message":{"content":"hi"}}` + "\n"
	}
	index("t-plan", "claude", write("plan.jsonl", entry("plan")))
	index("t-default", "claude", write("default.jsonl", entry("default")))
	index("t-junk", "claude", write("junk.jsonl", entry("somethingnew")))
	index("t-none", "claude", write("none.jsonl", `{"type":"user","cwd":`+quote(dir)+`}`+"\n"))
	index("l-plan", "claude", write("l1.jsonl", entry("auto")))
	index("l-codex", "codex", write("l2.jsonl", `{"type":"session_meta","payload":{"cwd":`+quote(dir)+`}}`+"\n"))
	index("l-bad", "claude", write("l3.jsonl", `{"type":"user","cwd":`+quote(dir)+`}`+"\n"))
	live := func(id, typ, mode string) {
		m := mode
		require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: typ, AgentName: id, WorkingDir: dir, PermissionMode: &m}))
	}
	live("l-plan", "claude", "plan") // the live row's record wins over the transcript's start
	live("l-codex", "codex", "acceptEdits")
	live("l-bad", "claude", "nonsense")

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
	assert.Equal(t, "plan", info("t-plan")["permission_mode"], "Claude's transcript starts in Plan")
	assert.Equal(t, "default", info("t-default")["permission_mode"], "a Default chat is Default, never the saved default")
	assert.NotContains(t, info("t-junk"), "permission_mode", "a string that is no mode is not offered")
	assert.NotContains(t, info("t-none"), "permission_mode", "none recorded: nothing said, the saved default stays")
	assert.Equal(t, "plan", info("l-plan")["permission_mode"], "the live row's recorded mode wins")
	assert.Equal(t, "default", info("l-codex")["permission_mode"], "a mode Codex lacks is Default")
	assert.NotContains(t, info("l-bad"), "permission_mode", "a recorded value that is no mode is not offered")
}
