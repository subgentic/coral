package routes

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13289: a session's commits say how many there are (total) and whether more are cut (has_more), beside the commits, oldest first as before.
func TestSessionHistoryGitSaysTotalAndHasMore(t *testing.T) {
	db, err := storetest.Open(t, t.TempDir()+"/hg.db")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	hh := NewHistoryHandler(db, &config.Config{}, nil)
	sid := "sess-13289"
	const n = 6
	for i := 0; i < n; i++ {
		s := sid
		require.NoError(t, hh.gs.UpsertGitSnapshot(t.Context(), &store.GitSnapshot{AgentName: "a", AgentType: "claude", WorkingDirectory: "/w", Branch: "main", CommitHash: fmt.Sprintf("%040d", i), CommitSubject: fmt.Sprintf("c%d", i), SessionID: &s}))
	}
	r := chi.NewRouter()
	r.Get("/api/sessions/history/{sessionID}/git", hh.GetSessionGit)
	get := func(q string) map[string]any {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/sessions/history/"+sid+"/git"+q, nil))
		require.Equal(t, http.StatusOK, w.Code)
		var out map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return out
	}
	all := get("")
	assert.Len(t, all["commits"], n, "under the default 20: all, as before")
	assert.EqualValues(t, n, all["total"])
	assert.Equal(t, false, all["has_more"])

	cut := get("?limit=4")
	assert.Len(t, cut["commits"], 4)
	assert.EqualValues(t, n, cut["total"], "the true number, not the page")
	assert.Equal(t, true, cut["has_more"])
	assert.Equal(t, "c0", cut["commits"].([]any)[0].(map[string]any)["commit_subject"], "oldest first, as before")

	exact := get("?limit=6")
	assert.Equal(t, false, exact["has_more"], "exactly one page")
	assert.EqualValues(t, n, exact["total"])
}
