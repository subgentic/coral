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

// #10390: the history list takes folder=<path> and each chat row says the folder it ran in (working_dir).
func TestHistoryListFiltersByFolderAndRowsSayTheirFolder(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ss := store.NewSessionStore(db)
	last := "2026-10-20T10:00:00Z"
	for id, dir := range map[string]string{"10390000-0000-4000-8000-0000000000a1": "/srv/app", "10390000-0000-4000-8000-0000000000a2": "/srv/other"} {
		require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &last, LastTimestamp: &last, MessageCount: 3, FileMtime: 1, WorkingDir: dir}))
	}
	h := NewHistoryHandler(db, &config.Config{}, bs)
	r := chi.NewRouter()
	r.Get("/api/sessions/history", h.ListSessions)
	server := httptest.NewServer(r)
	t.Cleanup(server.Close)

	resp, err := http.Get(server.URL + "/api/sessions/history?type=agent&folder=%2Fsrv%2Fapp")
	require.NoError(t, err)
	defer resp.Body.Close()
	var body struct {
		Sessions []map[string]any `json:"sessions"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Sessions, 1)
	assert.Equal(t, "/srv/app", body.Sessions[0]["working_dir"])
}
