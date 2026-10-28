package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

func TestChatMailboxRoutesFlagsFiltersCountsAndAuth(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	stamp := "2026-10-25T20:00:00Z"
	require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "chat", SourceType: "codex", SourceFile: "/fixture/chat", LastTimestamp: &stamp}))
	r := chi.NewRouter()
	r.Patch("/api/sessions/history/{sessionID}/flags", h.SetChatFlags)
	r.Get("/api/sessions/history/counts", h.ChatCounts)
	r.Get("/api/sessions/history", h.ListSessions)
	r.Get("/api/sessions/history/search", h.SearchChats)
	call := func(method, path, body, kind string, agent bool) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if kind != "" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		}
		if agent {
			req.Header.Set(store.SessionTokenHeader, "agent-token")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		out := map[string]any{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return rec.Code, out
	}
	for _, kind := range []string{"", callerAPIKey, callerDashCookie} {
		code, _ := call("PATCH", "/api/sessions/history/chat/flags", `{"starred":true}`, kind, true)
		assert.Equal(t, 403, code, "agent token cannot borrow operator identity")
	}
	code, _ := call("PATCH", "/api/sessions/history/chat/flags", `{"starred":true}`, "", false)
	assert.Equal(t, 403, code)
	for _, bad := range []string{`{}`, `{"starred":"yes"}`, `{"archived":0}`, `null`, `{"starred":true,"unknown":true}`} {
		code, _ = call("PATCH", "/api/sessions/history/chat/flags", bad, callerDashCookie, false)
		assert.Equal(t, 400, code, bad)
	}
	code, _ = call("PATCH", "/api/sessions/history/missing/flags", `{"starred":true}`, callerDashCookie, false)
	assert.Equal(t, 404, code)
	code, _ = call("PATCH", "/api/sessions/history/chat/flags", `{"starred":true,"archived":true}`, callerDashCookie, false)
	assert.Equal(t, 200, code)
	code, out := call("GET", "/api/sessions/history?type=agent", "", callerDashCookie, false)
	assert.Equal(t, 200, code)
	assert.EqualValues(t, 0, out["total"])
	code, out = call("GET", "/api/sessions/history?type=agent&starred=1&archived=1", "", callerDashCookie, false)
	assert.Equal(t, 200, code)
	assert.EqualValues(t, 1, out["total"])
	row := out["sessions"].([]any)[0].(map[string]any)
	assert.Equal(t, true, row["starred"])
	assert.Equal(t, true, row["archived"])
	assert.Equal(t, false, row["active"])
	code, out = call("GET", "/api/sessions/history/counts", "", callerDashCookie, false)
	assert.Equal(t, 200, code)
	assert.EqualValues(t, 0, out["all"])
	assert.EqualValues(t, 1, out["archived"])
	code, _ = call("GET", "/api/sessions/history/counts", "", "", true)
	assert.Equal(t, 403, code)
	code, _ = call("PATCH", "/api/sessions/history/chat/flags", `{"archived":false}`, callerAPIKey, false)
	assert.Equal(t, 200, code)
	code, out = call("GET", "/api/sessions/history?type=agent&starred=1", "", callerDashCookie, false)
	assert.Equal(t, 200, code)
	assert.EqualValues(t, 1, out["total"])
	assert.Equal(t, tunnel.TierNever, tunnel.Classify("PATCH", "/api/sessions/history/chat/flags", ""))
	assert.Equal(t, tunnel.TierView, tunnel.Classify("GET", "/api/sessions/history/counts", ""))
	assert.Equal(t, tunnel.TierView, tunnel.Classify("GET", "/api/sessions/history", "starred=1&active=1&archived=1&with_notes=1"))
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h.bs = bs
	_, err = bs.Subscribe(ctx, "group", "member", "Developer", "sid", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "group", "member", "mailbox search marker", nil)
	require.NoError(t, err)
	_, out = call("GET", "/api/sessions/history/search?type=group&q=marker", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"])
	// the dashboard sends the id through encodeURIComponent, so a group chat's colon arrives as %3A (#8011: Star and Archive on a group chat said "chat not found")
	code, _ = call("PATCH", "/api/sessions/history/board%3Agroup/flags", `{"starred":true}`, callerDashCookie, false)
	assert.Equal(t, 200, code, "the id as the dashboard sends it")
	code, _ = call("PATCH", "/api/sessions/history/board%3Agroup/flags", `{"starred":false}`, callerDashCookie, false)
	assert.Equal(t, 200, code)
	code, _ = call("PATCH", "/api/sessions/history/board:group/flags", `{"starred":true}`, callerDashCookie, false)
	assert.Equal(t, 200, code)
	code, out = call("GET", "/api/sessions/history?type=group&starred=1", "", callerDashCookie, false)
	assert.Equal(t, 200, code)
	assert.EqualValues(t, 1, out["total"])
	group := out["sessions"].([]any)[0].(map[string]any)
	assert.Equal(t, true, group["starred"])
	assert.Equal(t, false, group["active"])
	code, _ = call("PATCH", "/api/sessions/history/board:group/flags", `{"archived":true}`, callerDashCookie, false)
	assert.Equal(t, 200, code)
	_, out = call("GET", "/api/sessions/history?type=group", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"], "Group chats lists every board: an archived one stays reachable")
	assert.Equal(t, true, out["sessions"].([]any)[0].(map[string]any)["archived"], "and says it is archived")
	_, out = call("GET", "/api/sessions/history?starred=1", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"], "Starred (both kinds) holds the agent chat and not the archived board")
	_, out = call("GET", "/api/sessions/history?archived=1", "", callerDashCookie, false)
	assert.EqualValues(t, 0, out["total"], "Archived is agent chats only")
	_, out = call("GET", "/api/sessions/history/search?type=group&q=marker", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"], "Group chats search includes archived boards")
	assert.Equal(t, true, out["results"].([]any)[0].(map[string]any)["archived"])
	_, out = call("GET", "/api/sessions/history/search?q=marker", "", callerDashCookie, false)
	assert.EqualValues(t, 0, out["total"], "the global search still hides archived boards")
	_, out = call("GET", "/api/sessions/history?type=group&archived=1", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"], "type=group has no archived filter")
	_, out = call("GET", "/api/sessions/history/counts", "", callerDashCookie, false)
	assert.EqualValues(t, 0, out["archived"], "Archived counts agent chats only")
	assert.EqualValues(t, 1, out["all"], "All counts the visible agent chats")
	assert.EqualValues(t, 1, out["group"], "Group chats counts every board, the archived one too")

	_, err = db.ExecContext(ctx, "DELETE FROM session_index")
	require.NoError(t, err)
	code, _ = call("PATCH", "/api/sessions/history/board:group/flags", `{"archived":false}`, callerDashCookie, false)
	assert.Equal(t, 200, code)
	_, out = call("GET", "/api/sessions/history", "", callerDashCookie, false)
	assert.EqualValues(t, 1, out["total"], "group-only history is not the empty-install fast path")

}

// #10086: Unarchive on a chat whose agent is archived puts the agent back in the sidebar too, so the two Archived lists never disagree.
func TestChatUnarchiveAlsoUnarchivesTheAgent(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	stamp := "2026-10-25T20:00:00Z"
	require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "quiet-agent", SourceType: "claude", SourceFile: "/fixture/quiet-agent", LastTimestamp: &stamp}))
	require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "quiet-agent", AgentName: "quiet-agent", AgentType: "claude", WorkingDir: "/fixture"}))
	require.NoError(t, h.ss.SetSessionArchived(ctx, "quiet-agent", true))
	r := chi.NewRouter()
	r.Patch("/api/sessions/history/{sessionID}/flags", h.SetChatFlags)
	req := httptest.NewRequest("PATCH", "/api/sessions/history/quiet-agent/flags", strings.NewReader(`{"archived":false}`))
	req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	archived, err := h.ss.IsSessionArchived(ctx, "quiet-agent")
	require.NoError(t, err)
	assert.False(t, archived, "the agent is out of the sidebar's Archived section")
	got, err := h.ss.ListSessionsPaged(ctx, store.SessionListParams{PageSize: 10, Archived: true})
	require.NoError(t, err)
	assert.Empty(t, got.Sessions, "and out of Inbox > Archived")
}
