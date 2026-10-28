package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #9873: a board that never set its settings reads the two cross-team switches ON (#5916: kill switches; the Coral Hub team link is the permission) and everything else off, through the
// route the dashboard and the Hub read. The comment on CrossTeamArtifacts said "off by default" for years; this pins what the code does.
func TestBoardSettingsReadDefaultsForABoardThatNeverSetThem(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Get("/api/board/{project}/settings", h.GetBoardSettings)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/board/never-set/settings", nil))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var got map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, true, got["cross_team_messaging"], "messaging is on by default")
	assert.Equal(t, true, got["cross_team_artifacts"], "file sharing is on by default")
	assert.Equal(t, false, got["require_goal"], "the rest default to off")
	assert.Equal(t, false, got["goal_requests"])
	assert.Empty(t, got["cross_team_servers"], "no server is admitted by default")
	assert.Empty(t, got["cross_team_allowed"], "and nobody is allowed")
}
