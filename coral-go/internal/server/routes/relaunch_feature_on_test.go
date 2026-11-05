//go:build !relaunchfixture

package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13258: every build has the Hub's relaunch feature on (and the real updater), and a computer that has not been told to let the Hub relaunch it still does nothing: the routes are there, so a request is refused for what it is
// (no owner marker: 403 owner_only), not answered 404, and with the stamped owner but the person's switch never turned on the answer is the fixed hub_relaunch_off. The environment changes none of it
// (CORAL_RELAUNCH_FIXTURE_DIR is read by no code of this build).
func TestADefaultBuildHasTheRelaunchFeatureOnAndAnUntouchedSwitchRefusesTheHub(t *testing.T) {
	assert.True(t, updateRelaunchFeature)
	assert.NotNil(t, BuildRelaunchUpdater(t.TempDir(), nil))

	t.Setenv("CORAL_RELAUNCH_FIXTURE_DIR", t.TempDir())
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	h := NewUpdateRelaunchHandler(store.NewSessionStore(db), t.TempDir(), func() string { return "pty" }, BuildRelaunchUpdater(t.TempDir(), nil))
	assert.True(t, h.on(), "the Hub's relaunch feature is on")
	assert.True(t, h.localOn(), "and so are this computer's own update routes")

	rec := httptest.NewRecorder()
	h.Relaunch(rec, httptest.NewRequest(http.MethodPost, "/api/system/update/relaunch", nil))
	assert.Equal(t, http.StatusForbidden, rec.Code, "a relaunch request with no owner marker is refused as what it is, not 404")
	assert.Contains(t, rec.Body.String(), "owner_only")

	owner := callerIdentity{owner: true, pseudo: "hub-owner"}
	_, code := h.gate(context.Background(), owner)
	assert.Equal(t, "max_mode", code, "the owner through the Hub on an untouched computer: the Hub's cap is below launch")
	require.NoError(t, h.SetSetting(context.Background(), MaxModeSetting, "launch"))
	reason, code := h.gate(context.Background(), owner)
	assert.Equal(t, "hub_relaunch_off", code, "with the cap at launch but the person's switch never turned on: nothing happens")
	assert.NotEmpty(t, reason)
	require.NoError(t, h.SetSetting(context.Background(), HubRelaunchSetting, "true"))
	_, code = h.gate(context.Background(), owner)
	assert.Equal(t, "", code, "only the person's own switch opens it")
}
