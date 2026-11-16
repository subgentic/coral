package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// A search for one chat (session_id, #17912): the Chats page opens a found chat at its first match by asking the search for just that chat, so a chat past the first page of results is found too.
func TestChatSearchCanBeAskedForOneChat(t *testing.T) {
	db, ss, bs, dir, cleanup := setupChatSearchTestEnv(t)
	defer cleanup()
	ctx := context.Background()
	const query = "onechat17912"
	for i := 0; i < 30; i++ {
		id := fmt.Sprintf("sess-%02d", i)
		transcript := filepath.Join(dir, id+".jsonl")
		writeClaudeJSONLTranscript(t, transcript, []map[string]any{{"type": "user", "message": map[string]any{"content": "start"}}, {"type": "user", "message": map[string]any{"content": query + " message " + id}}})
		require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: transcript, DisplaySummary: query}))
		require.NoError(t, ss.UpsertFTS(ctx, id, query+" message "+id))
	}
	h := NewHistoryHandler(db, &config.Config{}, bs)
	routes := chi.NewRouter()
	routes.Get("/api/sessions/history/search", h.SearchChats)
	search := func(params string) []string {
		t.Helper()
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/history/search?q="+query+"&type=all"+params, nil))
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var body struct {
			Results []struct {
				SessionID string `json:"session_id"`
				Hits      []struct {
					Locator struct {
						MessageIndex int `json:"message_index"`
					} `json:"locator"`
				} `json:"hits"`
			} `json:"results"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		var ids []string
		for _, r := range body.Results {
			ids = append(ids, r.SessionID)
			require.Equal(t, 1, r.Hits[0].Locator.MessageIndex, "the hit is the second message")
		}
		return ids
	}
	require.Greater(t, len(search("")), 1, "without the filter the search lists many chats")
	require.Equal(t, []string{"sess-29"}, search("&session_id=sess-29"), "asked for one chat, it answers that chat only, wherever it ranks")
	require.Empty(t, search("&session_id=nosuch"))

	// #17982: asked for one chat, the search reads that chat itself: one the FTS shortlist (its first 200 rows) does not hold is found too.
	transcript := filepath.Join(dir, "outside.jsonl")
	writeClaudeJSONLTranscript(t, transcript, []map[string]any{{"type": "user", "message": map[string]any{"content": "start"}}, {"type": "user", "message": map[string]any{"content": query + " in a chat the index does not rank"}}})
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "outside", SourceType: "claude", SourceFile: transcript, DisplaySummary: "unrelated"}))
	require.NoError(t, ss.UpsertFTS(ctx, "outside", "nothing like the words"))
	require.NotContains(t, search(""), "outside", "the shortlist does not hold it")
	require.Equal(t, []string{"outside"}, search("&session_id=outside"), "asked for by id, it is read and found")
}
