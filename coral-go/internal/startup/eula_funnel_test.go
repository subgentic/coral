package startup

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/testguard"
	"github.com/subgentic/coral/internal/tracking"
)

// #10004 (Security's MUST, round 1): eula_accepted follows the SAVED analytics choice. The terms are accepted before Start (the terminal dialog, the legacy migration), when the choice has not been read
// yet; the event is sent from Start once it has been, and never for someone who opted out.
func TestEULAAcceptedFollowsTheSavedAnalyticsChoice(t *testing.T) {
	for _, tc := range []struct {
		name     string
		saved    string // the saved telemetry_enabled value ("" = nothing saved: on by default)
		wantSent int
	}{
		{"analytics off (opted out earlier)", "false", 0},
		{"analytics on", "true", 1},
		{"nothing saved: the default is on", "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The guard learns the real ~/.coral before this test points HOME at a temp folder, so the acceptance marker (under HOME/.coral) lands in the temp one.
			testguard.CheckDataPath(filepath.Join(t.TempDir(), "x"))
			iso := t.TempDir()
			for _, k := range []string{"TMPDIR", "TMP", "TEMP"} {
				t.Setenv(k, iso)
			}
			t.Setenv("HOME", filepath.Join(iso, "home"))
			t.Setenv("USERPROFILE", filepath.Join(iso, "home"))
			home := filepath.Join(iso, "data")
			t.Setenv("CORAL_DATA_DIR", home)
			t.Setenv("CORAL_NO_DEMO_SEED", "1")
			t.Setenv("CORAL_NO_WELCOME", "1")
			t.Setenv("CORAL_TELEMETRY_DISABLED", "")
			t.Setenv("CORAL_CLOUD_URL", "")
			require.NoError(t, os.MkdirAll(filepath.Join(iso, "home"), 0o700))
			require.NoError(t, os.MkdirAll(home, 0o700))
			if tc.saved != "" {
				db, err := store.OpenWithKey(context.Background(), filepath.Join(home, "sessions.db"), "")
				require.NoError(t, err)
				require.NoError(t, store.NewSessionStore(db).SetSetting(context.Background(), "telemetry_enabled", tc.saved))
				require.NoError(t, db.Close())
			}

			var mu sync.Mutex
			var sent []map[string]any
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				b, _ := io.ReadAll(r.Body)
				var p struct {
					Event      string         `json:"event"`
					Properties map[string]any `json:"properties"`
				}
				if json.Unmarshal(b, &p) == nil && p.Event == tracking.EventEULAAccepted {
					mu.Lock()
					sent = append(sent, p.Properties)
					mu.Unlock()
				}
				w.WriteHeader(http.StatusOK)
			}))
			defer sink.Close()
			tracking.WaitForAsyncForTest()
			oldKey := config.PostHogKey
			config.PostHogKey = "phc_test_key"
			defer func() { tracking.WaitForAsyncForTest(); config.PostHogKey = oldKey }()
			restore := tracking.ConfigureForTest(sink.URL, home, "install-under-test")
			defer restore()
			tracking.SetCoralDir(home) // as main does before the terms check

			// The terms are accepted in the terminal dialog, before the server has started: the saved analytics choice is not applied yet.
			license.TakeAcceptanceSource()
			require.NoError(t, license.WriteEULAMarker())
			tracking.WaitForAsyncForTest()
			mu.Lock()
			assert.Empty(t, sent, "nothing is sent where the marker is written: the saved choice is not known yet")
			mu.Unlock()

			cfg := config.Load(home)
			cfg.Host = "127.0.0.1"
			cfg.Port = freePort(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
			require.NoError(t, err)
			defer func() {
				cancel()
				rs.Shutdown(5 * time.Second)
				rs.Close()
			}()
			require.Eventually(t, func() bool {
				tracking.WaitForAsyncForTest()
				mu.Lock()
				defer mu.Unlock()
				return len(sent) >= tc.wantSent
			}, 5*time.Second, 50*time.Millisecond)
			time.Sleep(300 * time.Millisecond) // the window in which an unwanted event would arrive
			tracking.WaitForAsyncForTest()
			mu.Lock()
			defer mu.Unlock()
			assert.Len(t, sent, tc.wantSent)
			if tc.wantSent == 1 {
				assert.Equal(t, "dialog", sent[0]["source"])
				assert.EqualValues(t, tracking.SchemaVersion, sent[0]["schema_version"])
			}
			_, again := license.TakeAcceptanceSource()
			assert.False(t, again, "Start took it: it is sent once")
		})
	}
}
