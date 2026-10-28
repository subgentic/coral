package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #10635 (Security Reviewer Windows on #10390): a Hub viewer is shown a chat's folder under the home directory as "~/..." (rows and the counts' folder choices), the Folder filter takes that "~" form back and
// finds the chats, and a folder outside the home directory is shown and asked for as it is.
func TestHubViewerSeesFoldersUnderHomeAsTildeAndCanFilterByThem(t *testing.T) {
	home, _ := hubTestHome(t)
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ss := store.NewSessionStore(db)
	last := "2026-10-20T10:00:00Z"
	inHome, outside := filepath.Join(home, "proj"), filepath.FromSlash("/srv/app")
	for id, dir := range map[string]string{"10635000-0000-4000-8000-0000000000a1": inHome, "10635000-0000-4000-8000-0000000000a2": outside} {
		require.NoError(t, ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: "/f/" + id, FirstTimestamp: &last, LastTimestamp: &last, MessageCount: 3, FileMtime: 1, WorkingDir: dir}))
	}
	h := NewHistoryHandler(db, &config.Config{}, bs)
	r := chi.NewRouter()
	r.Use(HubPaths)
	r.Get("/api/sessions/history", h.ListSessions)
	r.Get("/api/sessions/history/counts", h.ChatCounts)
	get := func(path string, tunneled bool) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req = req.WithContext(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie))
		if tunneled {
			req.Header.Set(tunnel.ViaHeader, "hub")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		require.Equal(t, 200, rec.Code, rec.Body.String())
		out := map[string]any{}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	dirsOf := func(m map[string]any) []string {
		var out []string
		for _, d := range m["dirs"].([]any) {
			out = append(out, d.(map[string]any)["path"].(string))
		}
		return out
	}
	rowDirs := func(m map[string]any) []string {
		var out []string
		for _, s := range m["sessions"].([]any) {
			out = append(out, s.(map[string]any)["working_dir"].(string))
		}
		return out
	}

	counts := get("/api/sessions/history/counts", true)
	assert.ElementsMatch(t, []string{"~/proj", filepath.ToSlash(outside)}, dirsOf(counts), "the choices a Hub viewer gets: the home folder as ~, no account name")
	for _, d := range dirsOf(counts) {
		assert.False(t, strings.Contains(d, home), d)
	}
	assert.ElementsMatch(t, []string{inHome, outside}, dirsOf(get("/api/sessions/history/counts", false)), "this computer's own dashboard is shown the whole path")

	list := get("/api/sessions/history?type=agent", true)
	assert.ElementsMatch(t, []string{"~/proj", filepath.ToSlash(outside)}, rowDirs(list))

	byTilde := get("/api/sessions/history?type=agent&working_dir=%7E%2Fproj", true)
	assert.Equal(t, []string{"~/proj"}, rowDirs(byTilde), "the ~ form a Hub viewer was shown finds the chats that ran there")
	byOutside := get("/api/sessions/history?type=agent&working_dir="+filepathQuery(outside), true)
	assert.Equal(t, []string{filepath.ToSlash(outside)}, rowDirs(byOutside))
}

// filepathQuery is a path as a query value.
func filepathQuery(p string) string {
	return strings.NewReplacer("/", "%2F", `\`, "%5C", ":", "%3A").Replace(p)
}
