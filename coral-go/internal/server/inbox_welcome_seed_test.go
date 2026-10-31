package server

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store/storetest"
)

// The Inbox's welcome items (#11443) are for a new install only: it stores inbox_welcome=on when the install has never run (no row that says it has),
// an install that has run keeps none, and a test server (CORAL_NO_WELCOME=1) never asks.
func TestInboxWelcomeIsSeededForANewInstallOnly(t *testing.T) {
	value := func(t *testing.T, preset map[string]string, env string) (string, bool) {
		t.Setenv("CORAL_NO_WELCOME", env)
		cfg := newE2EConfig(t, t.TempDir())
		db, err := storetest.Open(t, cfg.DBPath)
		require.NoError(t, err)
		t.Cleanup(func() { db.Close() })
		for k, v := range preset {
			_, err := db.Exec(`INSERT INTO user_settings (key, value) VALUES (?, ?)`, k, v)
			require.NoError(t, err)
		}
		stack := newTermStack(t)
		newTestServer(t, cfg, db, stack.backend, stack.terminal)
		var got string
		err = db.GetContext(context.Background(), &got, `SELECT value FROM user_settings WHERE key = 'inbox_welcome'`)
		return got, err == nil
	}
	got, ok := value(t, nil, "")
	assert.True(t, ok, "a new install is seeded")
	assert.Equal(t, "on", got)
	_, ok = value(t, map[string]string{"git_diff_mode": "branch_point"}, "")
	assert.False(t, ok, "an install that has run before never sees the welcome items")
	_, ok = value(t, map[string]string{"welcome_choice": "skipped"}, "")
	assert.False(t, ok, "nor one that already answered the first-launch screen")
	_, ok = value(t, nil, "1")
	assert.False(t, ok, "a test server never asks")
}
