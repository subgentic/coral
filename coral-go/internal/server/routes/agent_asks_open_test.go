package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// A question may carry one page of Coral from the fixed list; the row says which, and any other value is refused before anything is stored (#18768).
func TestAnAskCarriesOnlyAListedPageToTheCard(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	o := owner("0001")
	registerAsker(t, ss, o)
	post := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, o))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks", h.Create)
		rr.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, bad := range []string{"https://example.com", "/analytics", "javascript:alert(1)", "nowhere"} {
		assert.Equal(t, http.StatusBadRequest, post(`{"text":"Look.","open":"`+bad+`"}`), bad)
	}
	assert.Empty(t, h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)), "a refused page stores nothing")
	require.Equal(t, http.StatusOK, post(`{"text":"Open Analytics and look around.","options":["Done"],"open":"analytics"}`))
	rows := h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1)
	assert.Equal(t, "analytics", rows[0].OpenPage)
	assert.Equal(t, []string{"Done"}, rows[0].Options)
	require.Equal(t, http.StatusOK, post(`{"text":"Plain question."}`))
	rows = h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
	require.Len(t, rows, 1)
	assert.Equal(t, "", rows[0].OpenPage, "a question with no page has none")
}

// A question may carry one picture: the id of the agent's own upload and its kind, never a path or a link; the row says which (#18768).
func TestAnAskCarriesOnlyAnArtifactIdAsItsPicture(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "a.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	h := NewAgentAsksHandler(ss, nil)
	o := owner("0001")
	registerAsker(t, ss, o)
	post := func(body string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/agent-asks", strings.NewReader(body))
		req = req.WithContext(context.WithValue(req.Context(), verifiedSessionKey{}, o))
		rec := httptest.NewRecorder()
		rr := chi.NewRouter()
		rr.Post("/api/agent-asks", h.Create)
		rr.ServeHTTP(rec, req)
		return rec.Code
	}
	hex := strings.Repeat("ab", 32)
	for _, bad := range []string{"https://example.com/a.png", "/etc/passwd.png", hex, hex + ".html", hex + ".png/../x", "../" + hex + ".png", hex[:60] + ".png", strings.ToUpper(hex) + ".png"} {
		assert.Equal(t, http.StatusBadRequest, post(`{"text":"Look.","image":"`+bad+`"}`), bad)
	}
	assert.Empty(t, h.Rows(httptest.NewRequest(http.MethodGet, "/", nil)), "a refused picture stores nothing")
	for _, ext := range []string{"png", "jpg", "jpeg", "svg"} {
		require.Equal(t, http.StatusOK, post(`{"text":"Look.","image":"`+hex+`.`+ext+`"}`), ext)
		rows := h.Rows(httptest.NewRequest(http.MethodGet, "/", nil))
		require.Len(t, rows, 1)
		assert.Equal(t, hex+"."+ext, rows[0].Image)
	}
}
