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

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #10390: a person names a past chat from its row or page: the name is its title in the list (over the first message and the notes' title), the reply says the title now shown, an empty name takes it off,
// and it is not notes. A name is one short line; a board is not named here.
func TestAPastChatCanBeNamedAndTheNameIsItsTitle(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	stamp := "2026-10-25T20:00:00Z"
	require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "chat", SourceType: "claude", SourceFile: "/fixture/chat", LastTimestamp: &stamp, FirstUserMessage: "fix the importer crash"}))
	r := chi.NewRouter()
	r.Patch("/api/sessions/history/{sessionID}/flags", h.SetChatFlags)
	r.Get("/api/sessions/history", h.ListSessions)
	call := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		out := map[string]any{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return rec.Code, out
	}
	row := func() map[string]any {
		_, list := call("GET", "/api/sessions/history?type=agent", "")
		rows := list["sessions"].([]any)
		require.Len(t, rows, 1)
		return rows[0].(map[string]any)
	}
	assert.Equal(t, "fix the importer crash", row()["title"])

	code, out := call("PATCH", "/api/sessions/history/chat/flags", `{"title":"  Importer\ncrash \u202e review "}`)
	require.Equal(t, 200, code)
	assert.Equal(t, "Importer crash review", out["title"], "one short line, the reply says the title shown")
	assert.Equal(t, "Importer crash review", row()["title"], "the person's name is the title over the first message")
	assert.Equal(t, "Importer crash review", row()["chat_title"])
	assert.Equal(t, false, row()["has_notes"], "a name is not notes")

	code, out = call("PATCH", "/api/sessions/history/chat/flags", `{"title":""}`)
	require.Equal(t, 200, code)
	assert.Equal(t, "fix the importer crash", out["title"], "an empty name takes it off: the first message is the title again")
	assert.Equal(t, "fix the importer crash", row()["title"])

	code, out = call("PATCH", "/api/sessions/history/chat/flags", `{"title":"`+strings.Repeat("a", 300)+`"}`)
	require.Equal(t, 200, code)
	assert.Len(t, []rune(out["title"].(string)), store.ChatTitleLimit)

	code, _ = call("PATCH", "/api/sessions/history/board:team/flags", `{"title":"x"}`)
	assert.Equal(t, 400, code, "a board is named by its board")
	code, _ = call("PATCH", "/api/sessions/history/missing/flags", `{"title":"x"}`)
	assert.Equal(t, 404, code)
	code, _ = call("PATCH", "/api/sessions/history/chat/flags", `{"title":5}`)
	assert.Equal(t, 400, code)
}
