package startup

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/server/routes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #13258 (the Operator's condition on the Hub update): the "Let Coral Hub relaunch this Coral to install updates" switch can be set when the server is started (--allow-hub-update, CORAL_ALLOW_HUB_UPDATE=1), so a
// computer nobody sits at can be managed from the Hub. It only turns the switch ON, at every start; unset changes nothing and never turns a saved switch off.
func TestApplyAllowHubUpdate(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		saved  string // the saved switch ("" = never saved)
		launch bool
		want   bool // routes.HubRelaunchAllowed afterwards
	}{
		{"nothing asked, nothing saved: off", "", false, false},
		{"asked at launch: on", "", true, true},
		{"asked at launch over a saved off: on again at every start", "false", true, true},
		{"not asked leaves a saved off", "false", false, false},
		{"not asked never turns a saved on off", "true", false, true},
		{"asked and already on", "true", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			db, err := storetest.Open(t, filepath.Join(dir, "sessions.db"))
			require.NoError(t, err)
			defer db.Close()
			ss := store.NewSessionStore(db)
			if tc.saved != "" {
				require.NoError(t, ss.SetSetting(ctx, routes.HubRelaunchSetting, tc.saved))
			}
			cfg := config.Load(dir)
			cfg.AllowHubUpdate = tc.launch
			require.NoError(t, applyAllowHubUpdate(ctx, db, cfg))
			settings, err := ss.GetSettings(ctx)
			require.NoError(t, err)
			assert.Equal(t, tc.want, routes.HubRelaunchAllowed(settings))
		})
	}
}
