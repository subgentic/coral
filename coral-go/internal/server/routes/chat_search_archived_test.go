package routes

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

func TestChatSearch8083GroupIncludesArchivedBoardsOnlyWhenAsked(t *testing.T) {
	db, ss, bs, dir, cleanup := setupChatSearchTestEnv(t)
	defer cleanup()
	ctx := context.Background()
	const query = "search8083"
	ids := map[string]int64{}
	for _, project := range []string{"visible", "archived", "unmatched"} {
		_, err := bs.Subscribe(ctx, project, "member", "Developer", "sid", nil, "all")
		require.NoError(t, err)
		text := query + " board message"
		if project == "unmatched" {
			text = "something else"
		}
		msg, err := bs.PostMessage(ctx, project, "member", text, nil)
		require.NoError(t, err)
		ids[project] = msg.ID
		if project != "visible" {
			yes := true
			require.NoError(t, ss.UpdateChatFlags(ctx, "board:"+project, nil, &yes))
		}
	}
	// Distinct scores give deterministic pagination independently of timestamp ties.
	_, err := bs.PostMessage(ctx, "visible", "member", query+" second match", nil)
	require.NoError(t, err)
	transcript := filepath.Join(dir, "agent.jsonl")
	writeClaudeJSONLTranscript(t, transcript, []map[string]any{{"type": "user", "message": map[string]any{"content": query + " agent message"}}})
	require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: "agent", SourceType: "claude", SourceFile: transcript, DisplaySummary: query}))
	require.NoError(t, ss.UpsertFTS(ctx, "agent", query+" agent message"))
	h := NewHistoryHandler(db, &config.Config{}, bs)
	routes := chi.NewRouter()
	routes.Get("/api/sessions/history/search", h.SearchChats)
	search := func(params string) (map[string]any, []map[string]any) {
		t.Helper()
		rec := httptest.NewRecorder()
		routes.ServeHTTP(rec, httptest.NewRequest("GET", "/api/sessions/history/search?q="+query+params, nil))
		require.Equal(t, 200, rec.Code, rec.Body.String())
		var body map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
		require.Equal(t, "complete", body["status"])
		rows := []map[string]any{}
		for _, row := range body["results"].([]any) {
			rows = append(rows, row.(map[string]any))
		}
		return body, rows
	}
	t.Run("group", func(t *testing.T) {
		body, rows := search("&type=group")
		require.EqualValues(t, 2, body["total"])
		require.Len(t, rows, 2)
		require.Equal(t, "board:visible", rows[0]["session_id"])
		require.Equal(t, false, rows[0]["archived"])
		require.Equal(t, "board:archived", rows[1]["session_id"])
		require.Equal(t, true, rows[1]["archived"])
		require.Equal(t, "group", rows[1]["type"])
		hit := rows[1]["hits"].([]any)[0].(map[string]any)
		locator := hit["locator"].(map[string]any)
		require.Equal(t, "archived", locator["project"])
		require.EqualValues(t, ids["archived"], locator["message_id"])
		first, a := search("&type=group&page_size=1")
		require.EqualValues(t, 2, first["total"])
		require.Equal(t, true, first["has_more"])
		require.Len(t, a, 1)
		require.Equal(t, "board:visible", a[0]["session_id"])
		second, b := search("&type=group&page_size=1&page=2")
		require.EqualValues(t, 2, second["total"])
		require.Equal(t, false, second["has_more"])
		require.Len(t, b, 1)
		require.Equal(t, "board:archived", b[0]["session_id"])
		require.Equal(t, true, b[0]["archived"])
	})
	for _, params := range []string{"", "&type=all", "&type=invalid", "&type=agent"} {
		t.Run("default-hidden"+params, func(t *testing.T) {
			body, rows := search(params)
			expected := 2
			if params == "&type=agent" {
				expected = 1
			}
			require.EqualValues(t, expected, body["total"])
			require.Len(t, rows, expected)
			for _, row := range rows {
				require.NotEqual(t, "board:archived", row["session_id"])
				require.NotEqual(t, "board:unmatched", row["session_id"])
			}
		})
	}
}
