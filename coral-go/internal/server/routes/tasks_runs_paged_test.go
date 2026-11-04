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

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13188: GET /api/tasks/runs says how many one-shot runs there are and where the next page starts; the first page is the newest, as before, and the cursor walks on with no gap and no repeat (runs sharing a time included).
func TestTaskRunsPageWithATotalAndACursor(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/runs.db")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	h := NewTasksHandler(db, &config.Config{})
	const n = 12
	for i := 0; i < n; i++ {
		_, err := h.sched.CreateOneshotRun(t.Context(), fmt.Sprintf("2026-10-10T10:%02d:00Z", i/2), nil) // pairs share a time
		require.NoError(t, err)
	}
	r := chi.NewRouter()
	r.Get("/api/tasks/runs", h.ListTasks)
	get := func(q string) (int, map[string]any) {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/tasks/runs"+q, nil))
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}

	code, first := get("")
	require.Equal(t, http.StatusOK, code)
	assert.Len(t, first["runs"], n, "under the default 50: every run, as before")
	assert.EqualValues(t, n, first["total"])
	assert.Equal(t, false, first["has_more"])
	assert.Nil(t, first["next_cursor"])

	seen := map[float64]bool{}
	q, pages, lastAt := "?limit=5", 0, ""
	for {
		code, p := get(q)
		require.Equal(t, http.StatusOK, code, p)
		pages++
		assert.EqualValues(t, n, p["total"])
		for _, x := range p["runs"].([]any) {
			run := x.(map[string]any)
			id := run["id"].(float64)
			require.False(t, seen[id], "sent once")
			seen[id] = true
			at := run["scheduled_at"].(string)
			if lastAt != "" {
				assert.GreaterOrEqual(t, lastAt, at, "newest first")
			}
			lastAt = at
		}
		if p["has_more"] != true {
			assert.Nil(t, p["next_cursor"])
			break
		}
		require.Len(t, p["runs"], 5)
		q = "?limit=5&cursor=" + p["next_cursor"].(string)
		require.Less(t, pages, 6)
	}
	assert.Len(t, seen, n)
	assert.Equal(t, 3, pages)

	b64 := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	for _, bad := range []string{"!!!", b64("x"), b64(`{"s":"","i":3}`), b64(`{"s":"2026","i":0}`), b64(`{"s":"2026","i":-1}`), strings.Repeat("A", 1100)} {
		code, _ := get("?cursor=" + bad)
		assert.Equal(t, http.StatusBadRequest, code, bad)
	}
}
