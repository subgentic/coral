package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #11070: a group chat row (Inbox > Board history) carries its board's display name beside its key. A team-launched board's key is an id (b-wvvnbdjqjb); the title stays that key (it is what
// the row opens), and board_label is what people read, so the list shows "Release crew" and not the id.
func TestHistoryGroupRowCarriesTheBoardsLabel(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })

	b, err := bs.CreateBoard(ctx, "Release crew", "Operator")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, b.ID, "poster", "Poster", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, b.ID, "poster", "hello", nil)
	require.NoError(t, err)

	h := NewHistoryHandler(db, &config.Config{}, bs)
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	resp, err := http.Get(server.URL + "/api/sessions/history?type=group&page_size=50")
	require.NoError(t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	require.Equal(t, 200, resp.StatusCode, string(body))
	var out struct {
		Sessions []struct {
			SessionID  string `json:"session_id"`
			Title      string `json:"title"`
			BoardLabel string `json:"board_label"`
		} `json:"sessions"`
	}
	require.NoError(t, json.Unmarshal(body, &out))
	require.Len(t, out.Sessions, 1, string(body))
	require.Equal(t, "board:"+b.ID, out.Sessions[0].SessionID)
	require.Equal(t, b.ID, out.Sessions[0].Title, "the title stays the board's key: it is what the row opens")
	require.Equal(t, "Release crew", out.Sessions[0].BoardLabel, "the board's display name travels with the row")
}
