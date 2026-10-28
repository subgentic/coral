package routes

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #10291: while the first index pass is going, the history list says so (indexing: true) and the dashboard says "Reading your past sessions", not "No chats here"; once it is done the key is gone.
func TestHistoryListSaysWhenItIsStillReading(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "chats.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "boards.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewHistoryHandler(db, &config.Config{}, bs)
	read := func() map[string]any {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/api/sessions/history?type=agent", nil)
		h.ListSessions(rec, req)
		require.Equal(t, 200, rec.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	assert.NotContains(t, read(), "indexing", "no indexer to ask: no claim")
	ready := false
	h.SetIndexReady(func() bool { return ready })
	got := read()
	assert.Equal(t, true, got["indexing"], "an empty list while the first pass is going says it is still reading")
	assert.EqualValues(t, 0, got["total"])
	ready = true
	assert.NotContains(t, read(), "indexing", "once the first pass is done an empty list is just empty")
}
