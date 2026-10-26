package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// All chats is the agent chats and the group chats in one list by time, read a page at a time: every page together is every chat once, in order, however many pages there are (#8011: the list said
// 196 and gave 53, because a page of agent chats was merged with the group chats and then cut into pages again).
func TestAllChatsPagesAddUpToTheTotal(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	base := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 130; i++ {
		stamp := base.Add(time.Duration(i) * time.Hour).Format(time.RFC3339)
		require.NoError(t, h.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: fmt.Sprintf("agent-%03d", i), SourceType: "claude", SourceFile: fmt.Sprintf("/fixture/%d", i), LastTimestamp: &stamp}))
	}
	for _, p := range []string{"alpha", "beta", "gamma"} { // three group chats
		_, err = bs.Subscribe(ctx, p, "member", "Developer", "sid-"+p, nil, "all")
		require.NoError(t, err)
		_, err = bs.PostMessage(ctx, p, "member", "hello "+p, nil)
		require.NoError(t, err)
	}
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	get := func(path string) (int, []string, float64) {
		req := httptest.NewRequest("GET", path, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		var out struct {
			Sessions []struct {
				ID string `json:"session_id"`
				At string `json:"last_timestamp"`
			} `json:"sessions"`
			Total float64 `json:"total"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		ids := make([]string, len(out.Sessions))
		for i, s := range out.Sessions {
			ids[i] = s.ID
		}
		return rec.Code, ids, out.Total
	}
	for _, size := range []int{50, 7, 200} {
		var all []string
		var total float64
		for page := 1; page <= 40; page++ {
			code, ids, tot := get(fmt.Sprintf("/api/sessions/history?type=all&page=%d&page_size=%d", page, size))
			require.Equal(t, 200, code)
			total = tot
			if len(ids) == 0 {
				break
			}
			assert.LessOrEqual(t, len(ids), size)
			all = append(all, ids...)
		}
		assert.EqualValues(t, 133, total)
		assert.Len(t, all, 133, "page size %d: every chat is on some page", size)
		seen := map[string]bool{}
		for _, id := range all {
			assert.False(t, seen[id], "page size %d: %s on two pages", size, id)
			seen[id] = true
		}
	}
	// and a page is the same rows however it is asked for: page 2 of 50 is rows 51 to 100 of the one big page
	_, big, _ := get("/api/sessions/history?type=all&page=1&page_size=200")
	_, second, _ := get("/api/sessions/history?type=all&page=2&page_size=50")
	assert.Equal(t, big[50:100], second)
}
