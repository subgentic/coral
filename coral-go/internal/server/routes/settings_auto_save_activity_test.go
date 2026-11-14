package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/go-chi/chi/v5"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #16972 (walk 44 F5): the page marks a Welcome step done by itself when the person did it elsewhere (made a team, launched an agent); that save is not a click, and Activity showed it as
// "Dismissed a row in Needs you" for a card nobody touched. A Dismiss is a click and still gets its row.
func TestWelcomeSettingsSavedByThePageAreNotADismissal(t *testing.T) {
	put := func(t *testing.T, auto bool) (*activityPending, string) {
		db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
		require.NoError(t, err)
		defer db.Close()
		h := NewSystemHandler(db, nil)
		pend := &activityPending{}
		r := httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(`{"inbox_welcome_done":"team"}`))
		r.Header.Set("Content-Type", "application/json")
		if auto {
			r.Header.Set(AutoSaveHeader, "1")
		}
		r = r.WithContext(context.WithValue(r.Context(), activityPendingKey{}, pend))
		rec := httptest.NewRecorder()
		h.PutSettings(rec, r)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		s, _ := store.NewSessionStore(db).GetSettings(t.Context())
		return pend, s["inbox_welcome_done"]
	}
	clicked, saved := put(t, false)
	assert.True(t, clicked.set, "a Dismiss is the Operator's click")
	assert.Equal(t, board.ActInboxHide, clicked.action)
	assert.Equal(t, "team", saved)

	auto, saved := put(t, true)
	assert.False(t, auto.set, "the page keeping its own count is not a row of Activity")
	assert.Equal(t, "team", saved, "and the setting is still saved")
}

// #16972 (walk 44 F5): a person's settings save is a row naming the settings (never their values), and the page's own save is not.
func TestASettingsSaveByAPersonIsARowThatNamesTheSettingsOnly(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
	require.NoError(t, err)
	defer db.Close()
	h := NewSystemHandler(db, nil)
	put := func(auto bool) *activityPending {
		pend := &activityPending{}
		r := httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(`{"theme":"dark","fit_pane_width":"true"}`))
		r.Header.Set("Content-Type", "application/json")
		if auto {
			r.Header.Set(AutoSaveHeader, "1")
		}
		r = r.WithContext(context.WithValue(r.Context(), activityPendingKey{}, pend))
		rec := httptest.NewRecorder()
		h.PutSettings(rec, r)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		return pend
	}
	p := put(false)
	require.True(t, p.set)
	assert.Equal(t, board.ActSettingChange, p.action)
	assert.Equal(t, "fit_pane_width, theme", p.note, "the names, sorted")
	assert.NotContains(t, p.note, "dark", "never a value")
	assert.False(t, put(true).set, "the page's own save is not a row")
}

// #16972: Sleep and Wake of one agent are rows, after they happened.
func TestSleepingAndWakingOneAgentAreRows(t *testing.T) {
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid(1), AgentName: "a", AgentType: "claude", WorkingDir: t.TempDir()}))
	r := chi.NewRouter()
	r.Use(testIdentity(h.db))
	r.Post("/api/sessions/live/{sessionID}/sleep", h.SleepSession)
	call := func(id string) *activityPending {
		pend := &activityPending{}
		req := httptest.NewRequest("POST", "/api/sessions/live/"+id+"/sleep", strings.NewReader(`{}`))
		req = req.WithContext(context.WithValue(req.Context(), activityPendingKey{}, pend))
		r.ServeHTTP(httptest.NewRecorder(), req)
		return pend
	}
	p := call(sid(1))
	require.True(t, p.set, "the sleep happened")
	assert.Equal(t, board.ActAgentSleep, p.action)
	assert.Equal(t, "a", p.item)
	assert.False(t, call(sid(2)).set, "an unknown agent answers 200 with ok:false and is not a row")
}
