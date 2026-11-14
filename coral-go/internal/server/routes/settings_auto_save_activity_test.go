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

	"github.com/subgentic/coral/internal/board"
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
