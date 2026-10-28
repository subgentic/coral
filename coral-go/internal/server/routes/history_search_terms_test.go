package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
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

// #10137 (Desktop #10131): Inbox > All chats searched for a code like PLUM-4471, the request failed on an FTS5 syntax error and the page said "Loading chats..." for ever. The search answers with the
// chat and one line of its text around the match, for a code, a version and an address, in every mode; a phrase with a quote left open is a search, not an error.
func TestAllChatsSearchFindsCodesAndShowsAHitLine(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	last := "2026-10-20T10:00:00Z"
	for id, body := range map[string]string{
		"chat-plum":  "customer ticket PLUM-4471 is about the billing deploy\nsecond line",
		"chat-ver":   "shipped v2.0.3 to beta",
		"chat-other": "nothing to see here",
	} {
		require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, LastTimestamp: &last, FirstTimestamp: &last, MessageCount: 2, FileMtime: 1}))
		require.NoError(t, h.ss.UpsertFTS(ctx, id, body))
	}
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	get := func(q, mode string) (int, []map[string]any) {
		v := url.Values{"type": {"all"}, "q": {q}}
		if mode != "" {
			v.Set("fts_mode", mode)
		}
		req := httptest.NewRequest("GET", "/api/sessions/history?"+v.Encode(), nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var out struct {
			Sessions []map[string]any `json:"sessions"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out.Sessions
	}
	for _, mode := range []string{"", "phrase", "and", "or"} {
		code, rows := get("PLUM-4471", mode)
		require.Equal(t, 200, code, "mode %q: the search answers", mode)
		require.Len(t, rows, 1, mode)
		assert.Equal(t, "chat-plum", rows[0]["session_id"])
		snippet, _ := rows[0]["snippet"].(string)
		assert.Contains(t, snippet, "PLUM-4471", "the hit line shows the matched code")
		assert.NotContains(t, snippet, "\n")
	}
	code, rows := get("v2.0.3", "")
	require.Equal(t, 200, code)
	require.Len(t, rows, 1)
	assert.Equal(t, "chat-ver", rows[0]["session_id"])
	code, _ = get(`"unclosed PLUM-4471`, "or")
	assert.Equal(t, 200, code, "a quote left open is words, not an error")
	code, _ = get("a:b (c) -d *", "and")
	assert.Equal(t, 200, code)
}
