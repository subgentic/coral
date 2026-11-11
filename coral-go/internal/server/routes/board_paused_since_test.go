package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #15331: the team page says "Paused since 14:05", so a paused board's answer carries when the pause began, and a board that is not paused carries nothing.
func TestAPausedBoardSaysSinceWhenItWasPausedAndAResumedOneNothing(t *testing.T) {
	_, h := setupBoardTestServer(t)
	r := chi.NewRouter()
	r.Post("/api/board/{project}/pause", h.PauseBoard)
	r.Post("/api/board/{project}/resume", h.ResumeBoard)
	r.Get("/api/board/{project}/paused", h.GetPaused)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	get := func() map[string]any {
		resp, err := http.Get(srv.URL + "/api/board/team/paused")
		require.NoError(t, err)
		defer resp.Body.Close()
		var out map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
		return out
	}
	post := func(path string) {
		resp, err := http.Post(srv.URL+path, "application/json", nil)
		require.NoError(t, err)
		resp.Body.Close()
	}
	assert.Equal(t, false, get()["paused"])
	assert.NotContains(t, get(), "since")

	before := time.Now().UTC().Add(-2 * time.Second)
	post("/api/board/team/pause")
	got := get()
	assert.Equal(t, true, got["paused"])
	since, ok := got["since"].(string)
	require.True(t, ok, "a paused board says when: %v", got)
	at, err := time.Parse(time.RFC3339, since)
	require.NoError(t, err)
	assert.True(t, at.After(before) && at.Before(time.Now().UTC().Add(2*time.Second)), since)
	assert.Equal(t, false, got["by_sleep"], "a person's pause")

	h.PauseForSleep("other")
	assert.Equal(t, true, func() any {
		resp, _ := http.Get(srv.URL + "/api/board/other/paused")
		var o map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&o)
		resp.Body.Close()
		return o["by_sleep"]
	}(), "a team's sleep pause says so")

	post("/api/board/team/resume")
	got = get()
	assert.Equal(t, false, got["paused"])
	assert.NotContains(t, got, "since", "a resumed board has no pause time")
}
