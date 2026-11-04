package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13258: Settings says "on (set at launch)" beside the Hub update switch when --allow-hub-update / CORAL_ALLOW_HUB_UPDATE set it: the status carries hub_relaunch_updates_at_launch whenever the server was started with the flag
// and the server was started asking for it; while the flag is set the status says so even when the person turned the switch off (it comes back at the next start).
func TestStatusSaysTheHubUpdateSwitchWasSetAtLaunch(t *testing.T) {
	status := func(t *testing.T, atLaunch bool, saved string) map[string]any {
		t.Helper()
		db, err := storetest.Open(t, filepath.Join(t.TempDir(), "c.db"))
		require.NoError(t, err)
		t.Cleanup(func() { db.Close() })
		ss := store.NewSessionStore(db)
		if saved != "" {
			require.NoError(t, ss.SetSetting(context.Background(), HubRelaunchSetting, saved))
		}
		h := NewCloudHandler(ss, t.TempDir())
		h.SetPeerCheck(func(*http.Request) (bool, bool) { return true, true }) // the person's own request
		h.HubUpdateAtLaunch = atLaunch
		rec := httptest.NewRecorder()
		h.GetStatus(rec, localStatusRequest())
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return out
	}
	on := status(t, true, "true")
	assert.Equal(t, true, on["hub_relaunch_updates"])
	assert.Equal(t, true, on["hub_relaunch_updates_at_launch"], "on, set at launch")
	_, present := status(t, false, "true")["hub_relaunch_updates_at_launch"]
	assert.False(t, present, "turned on in Settings, not at launch: no words")
	// the flag is reported while it is set, even after the person turned the switch off: Settings then says it comes back at the next start
	off := status(t, true, "false")
	assert.Equal(t, false, off["hub_relaunch_updates"])
	assert.Equal(t, true, off["hub_relaunch_updates_at_launch"], "turned off since the launch, but the flag will turn it on again at the next start")
}

func localStatusRequest() *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://localhost/api/cloud/status", nil)
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	return r
}
