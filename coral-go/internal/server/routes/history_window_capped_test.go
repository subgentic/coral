package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13289: the merged All chats list reads at most maxMergedWindow agent chats; a page past that says so (window_capped, max_page) instead of being silently empty. A page inside the window has neither key.
func TestAllChatsPastTheMergeWindowSaysSo(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/chats.db")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	stamp := "2026-10-25T20:00:00Z"
	require.NoError(t, h.ss.UpsertSessionIndex(t.Context(), &store.SessionIndex{SessionID: "chat", SourceType: "codex", SourceFile: "/fixture/chat", LastTimestamp: &stamp}))
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	get := func(q string) map[string]any {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/sessions/history?type=all&date_from=2000-01-01"+q, nil))
		require.Equal(t, http.StatusOK, w.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return out
	}
	in := get("&page=400&page_size=50") // 400 x 50 = 20,000: the last page inside the window
	assert.NotContains(t, in, "window_capped")
	assert.NotContains(t, in, "max_page")
	first := get("")
	assert.NotContains(t, first, "window_capped", "the first page is as it always was")
	past := get("&page=401&page_size=50")
	assert.Equal(t, true, past["window_capped"])
	assert.EqualValues(t, 400, past["max_page"])
	assert.EqualValues(t, 1, past["total"], "the total stays the true number")
	assert.Empty(t, past["sessions"])
	big := get("&page=101&page_size=200") // 101 x 200 = 20,200
	assert.Equal(t, true, big["window_capped"])
	assert.EqualValues(t, 100, big["max_page"])
}
