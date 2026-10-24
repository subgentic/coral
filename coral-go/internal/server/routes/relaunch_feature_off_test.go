//go:build !relaunchfixture

package routes

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #5452, Security's condition 6, as #7343 split it: a build without the relaunchfixture tag has the Hub's relaunch feature off (it has the real updater, which the Hub's routes do not reach), so
// the Hub's relaunch and what a request through Coral Hub is told answer 404 as they always did, whatever the environment says (CORAL_RELAUNCH_FIXTURE_DIR is read by no code of this build).
// This computer's own status is on in every build (the dashboard's Updates pane and Install update), and says so with relaunch_available false.
func TestADefaultBuildHasTheRelaunchFeatureOffAndNoUpdater(t *testing.T) {
	assert.False(t, updateRelaunchFeature)
	assert.NotNil(t, BuildRelaunchUpdater(t.TempDir(), nil), "the real updater is built into every release; the Hub's routes do not reach it while the feature is off")

	t.Setenv("CORAL_RELAUNCH_FIXTURE_DIR", t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	h := NewUpdateRelaunchHandler(store.NewSessionStore(db), t.TempDir(), func() string { return "pty" }, BuildRelaunchUpdater(t.TempDir(), nil))
	rec := httptest.NewRecorder()
	h.Relaunch(rec, httptest.NewRequest(http.MethodPost, "/api/system/update/relaunch", nil))
	assert.Equal(t, http.StatusNotFound, rec.Code, "the Hub's relaunch")

	hub := httptest.NewRequest(http.MethodGet, "/api/system/update", nil)
	hub.Header.Set(tunnel.ViaHeader, cloud.ViaSecret())
	rec = httptest.NewRecorder()
	h.Status(rec, hub)
	assert.Equal(t, http.StatusNotFound, rec.Code, "the status through Coral Hub")

	assert.False(t, h.on(), "the Hub's relaunch feature is off")
	assert.True(t, h.localOn(), "this computer's own update routes are on")
}
