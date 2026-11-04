package routes

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #13188: an agent's git snapshots (by name) say how many there are and where the next page starts; no cursor is the same newest page as before.
func TestLiveGitSnapshotsPageWithATotalAndACursor(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	ctx := t.Context()
	const n = 8
	for i := 0; i < n; i++ {
		require.NoError(t, h.gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "pager", AgentType: "claude", WorkingDirectory: "/w", Branch: "main", CommitHash: fmt.Sprintf("%040d", i), CommitSubject: fmt.Sprintf("commit %d", i)}))
	}
	r := chi.NewRouter()
	r.Get("/api/sessions/live/{name}/git", h.Git)
	get := func(q string) (int, map[string]any) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/sessions/live/pager/git"+q, nil)
		req.RemoteAddr = "127.0.0.1:50000"
		req.Header.Set("Sec-Fetch-Site", "same-origin") // the local dashboard itself, not a bounded caller
		r.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, first := get("")
	require.Equal(t, http.StatusOK, code, first)
	assert.Len(t, first["snapshots"], n, "under the default 20: all, as before")
	assert.EqualValues(t, n, first["total"])
	assert.Equal(t, false, first["has_more"])

	seen := map[float64]bool{}
	q, pages := "?limit=3", 0
	for {
		code, p := get(q)
		require.Equal(t, http.StatusOK, code, p)
		pages++
		for _, x := range p["snapshots"].([]any) {
			id := x.(map[string]any)["id"].(float64)
			require.False(t, seen[id], "sent once")
			seen[id] = true
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, p["snapshots"], 3)
		q = "?limit=3&cursor=" + p["next_cursor"].(string)
		require.Less(t, pages, 6)
	}
	assert.Len(t, seen, n)
	assert.Equal(t, 3, pages)

	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, bad := range []string{"!!!", b64("x"), b64(`{"r":"","i":3}`), b64(`{"r":"2026","i":0}`), strings.Repeat("A", 1100)} {
		code, _ := get("?cursor=" + bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}

// QA's boundaries (#13188): a list of exactly one page, and the 1,024-character cursor cap.
func TestLiveGitPagedBoundaries(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	ctx := t.Context()
	for i := 0; i < 4; i++ {
		require.NoError(t, h.gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: "edge", AgentType: "claude", WorkingDirectory: "/w", Branch: "main", CommitHash: fmt.Sprintf("%040d", i), CommitSubject: fmt.Sprintf("c%d", i)}))
	}
	r := chi.NewRouter()
	r.Get("/api/sessions/live/{name}/git", h.Git)
	get := func(q string) (int, map[string]any) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/api/sessions/live/edge/git"+q, nil)
		req.RemoteAddr = "127.0.0.1:50000"
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		r.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	code, p := get("?limit=4")
	require.Equal(t, http.StatusOK, code, p)
	assert.Len(t, p["snapshots"], 4)
	assert.Equal(t, false, p["has_more"])
	assert.Nil(t, p["next_cursor"])
	_, p = get("?limit=3")
	require.Equal(t, true, p["has_more"])
	_, p = get("?limit=3&cursor=" + p["next_cursor"].(string))
	assert.Len(t, p["snapshots"], 1, "the next page is the one row")
	assert.Equal(t, false, p["has_more"])

	padded := func(chars int) string {
		body := `{"r":"2026-10-10T10:02:00Z","i":3}`
		return base64.RawURLEncoding.EncodeToString([]byte(body + strings.Repeat(" ", chars*3/4-len(body))))
	}
	code, _ = get("?cursor=" + padded(1024))
	assert.Equal(t, http.StatusOK, code, "exactly 1,024 characters")
	code, _ = get("?cursor=" + padded(1028))
	assert.Equal(t, http.StatusBadRequest, code, "1,028 characters")
}
