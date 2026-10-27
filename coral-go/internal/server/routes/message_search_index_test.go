package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
)

// GET /api/system/message-search-index says the setting, the state and the size, for Settings (#9685).
func TestMessageSearchIndexStatusRoute(t *testing.T) {
	t.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	bs, err := boardtest.Open(t.TempDir() + "/board_search_index.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewBoardHandler(bs)
	t.Cleanup(h.WaitBackground)
	r := chi.NewRouter()
	r.Get("/api/system/message-search-index", h.MessageSearchIndexStatus)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	get := func() map[string]any {
		resp, err := http.Get(srv.URL + "/api/system/message-search-index")
		require.NoError(t, err)
		defer resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode)
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	got := get()
	assert.Equal(t, "off", got["setting"])
	assert.Equal(t, "off", got["state"])
	assert.EqualValues(t, 0, got["size_bytes"])
	assert.Contains(t, got, "available")

	t.Setenv("CORAL_BOARD_SEARCH_INDEX", "")
	assert.Equal(t, "on", get()["setting"], "on when nothing is set")
}
