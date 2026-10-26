package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

// Each chat folder's count is the total of the list the folder shows (#8065): All, Active now, Archived and Notes are the
// agent chats (type=agent), Group chats is every board (type=group, an archived one flagged), Starred is both kinds.
func TestChatFolderCountsAreTheTotalsOfTheirLists(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "folders.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "folders-board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	stamp := "2026-10-25T20:00:00Z"
	for _, id := range []string{"plain", "starred", "archived", "noted", "live"} {
		require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "codex", SourceFile: "/fixture/" + id, LastTimestamp: &stamp}))
	}
	require.NoError(t, h.ss.SaveSessionNotes(ctx, "noted", "notes"))
	yes := true
	require.NoError(t, h.ss.UpdateChatFlags(ctx, "starred", &yes, nil))
	require.NoError(t, h.ss.UpdateChatFlags(ctx, "archived", nil, &yes))
	for _, board := range []string{"alpha", "beta", "gamma"} {
		_, err := bs.Subscribe(ctx, board, "member", "Developer", "sid-"+board, nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, board, "member", "hello", nil)
		require.NoError(t, err)
	}
	require.NoError(t, h.ss.UpdateChatFlags(ctx, "board:alpha", &yes, nil))  // a starred board
	require.NoError(t, h.ss.UpdateChatFlags(ctx, "board:beta", nil, &yes))   // an archived board
	require.NoError(t, h.ss.UpdateChatFlags(ctx, "board:gamma", &yes, &yes)) // starred and archived
	// an agent awake on alpha: the board is "active" in its own row, but Active now counts agent chats only
	require.NoError(t, h.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "live", AgentName: "live", AgentType: "codex", WorkingDir: "/fixture", PID: 123, BoardName: strPtr("alpha")}))

	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	r.Get("/api/sessions/history/counts", h.ChatCounts)
	get := func(path string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, http.StatusOK, rec.Code, path+": "+rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	counts := get("/api/sessions/history/counts")
	for folder, path := range map[string]string{
		"all":      "/api/sessions/history?type=agent",
		"group":    "/api/sessions/history?type=group",
		"notes":    "/api/sessions/history?type=agent&with_notes=1",
		"active":   "/api/sessions/history?type=agent&active=1",
		"archived": "/api/sessions/history?type=agent&archived=1",
		"starred":  "/api/sessions/history?starred=1",
	} {
		assert.EqualValues(t, get(path)["total"], counts[folder], "the %s folder's count is its list's total (%s)", folder, path)
	}
	assert.EqualValues(t, 4, counts["all"], "plain, starred, noted and live: the visible agent chats")
	assert.EqualValues(t, 3, counts["group"], "every board, the archived ones too")
	assert.EqualValues(t, 1, counts["archived"], "the archived agent chat; no board")
	assert.EqualValues(t, 1, counts["notes"])
	assert.EqualValues(t, 1, counts["active"], "the live agent chat only")
	assert.EqualValues(t, 2, counts["starred"], "the starred agent chat and the starred board that is not archived")

	byName := map[string]map[string]any{}
	for _, s := range get("/api/sessions/history?type=group")["sessions"].([]any) {
		row := s.(map[string]any)
		byName[row["title"].(string)] = row
	}
	require.Len(t, byName, 3)
	assert.Equal(t, false, byName["alpha"]["archived"])
	assert.Equal(t, true, byName["beta"]["archived"], "an archived board stays in Group chats, flagged")
	assert.Equal(t, true, byName["gamma"]["archived"])
	for _, s := range get("/api/sessions/history?archived=1")["sessions"].([]any) {
		assert.NotEqual(t, "group", s.(map[string]any)["type"], "no board in a list of both kinds under Archived")
	}
	for _, s := range get("/api/sessions/history?starred=1")["sessions"].([]any) {
		assert.NotEqual(t, "board:gamma", s.(map[string]any)["session_id"], "an archived board is not in Starred")
	}
}

func strPtr(s string) *string { return &s }
