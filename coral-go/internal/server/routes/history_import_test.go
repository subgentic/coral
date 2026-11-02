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

// #11970: the chat import status says how many earlier chats wait and by which CLI; only the person imports; the import is recorded and kicks a pass.
func TestHistoryImportStatusAndImport(t *testing.T) {
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "imp.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewHistoryHandler(db, &config.Config{}, nil)
	kicks := 0
	h.indexKick = func() { kicks++ }
	require.NoError(t, h.ss.NoteUnimported(ctx, []store.UnimportedChat{
		{SourceType: "claude", SourceFile: "/h/a", FileMtime: 1, SessionID: "a"},
		{SourceType: "claude", SourceFile: "/h/b", FileMtime: 1, SessionID: "b"},
		{SourceType: "codex", SourceFile: "/h/c", FileMtime: 1, SessionID: "c"},
	}))
	r := chi.NewRouter()
	r.Get("/api/history-import", h.HistoryImportStatus)
	r.Post("/api/history-import", h.ImportEarlierChats)
	callBody := func(method, kind, body string) int {
		req := httptest.NewRequest(method, "/api/history-import", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		return rec.Code
	}
	call := func(method, kind string, agent bool) (int, map[string]any) {
		req := httptest.NewRequest(method, "/api/history-import", nil)
		if kind != "" {
			req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, kind))
		}
		if agent {
			req.Header.Set(store.SessionTokenHeader, "agent-token")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		out := map[string]any{}
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	code, _ := call("POST", "", true)
	assert.Equal(t, 403, code, "an agent cannot import the person's other chats")
	code, _ = call("GET", "", true)
	assert.Equal(t, 403, code)
	assert.Zero(t, kicks)

	code, out := call("GET", callerDashCookie, false)
	require.Equal(t, 200, code)
	assert.Equal(t, false, out["imported"])
	assert.EqualValues(t, 3, out["found"])
	assert.Equal(t, map[string]any{"claude": float64(2), "codex": float64(1)}, out["sources"])

	code, _ = call("POST", callerDashCookie, false)
	require.Equal(t, 200, code)
	assert.Equal(t, 1, kicks)
	_, out = call("GET", callerDashCookie, false)
	assert.Equal(t, true, out["imported"])
	assert.EqualValues(t, 0, out["found"])

	// off again (Settings): {"imported": false}; anything else in the body is refused
	assert.Equal(t, 400, callBody("POST", callerDashCookie, `{"imported":`))
	assert.Equal(t, 200, callBody("POST", callerDashCookie, `{"imported":false}`))
	_, out = call("GET", callerDashCookie, false)
	assert.Equal(t, false, out["imported"])
	assert.Equal(t, 403, callBody("POST", "", `{"imported":false}`), "no operator, no switch")
}
