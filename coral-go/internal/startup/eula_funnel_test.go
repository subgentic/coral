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

// funnelEnv isolates a data folder and a capture endpoint for the tests that start the server and read what eula_accepted was sent (#10106).
type funnelEnv struct {
	t    *testing.T
	home string
	mu   sync.Mutex
	sent []map[string]any
}

func newFunnelEnv(t *testing.T) *funnelEnv {
	testguard.CheckDataPath(filepath.Join(t.TempDir(), "x")) // the guard learns the real ~/.coral before HOME moves
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
	e := &funnelEnv{t: t, home: home}
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var p struct {
			Event      string         `json:"event"`
			Properties map[string]any `json:"properties"`
		}
		if json.Unmarshal(b, &p) == nil && p.Event == tracking.EventEULAAccepted {
			e.mu.Lock()
			e.sent = append(e.sent, p.Properties)
			e.mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.Close)
	tracking.WaitForAsyncForTest()
	oldKey := config.PostHogKey
	config.PostHogKey = "phc_test_key"
	restore := tracking.ConfigureForTest(sink.URL, home, "install-under-test")
	t.Cleanup(func() { tracking.WaitForAsyncForTest(); restore(); config.PostHogKey = oldKey })
	tracking.SetCoralDir(home)
	return e
}

func (e *funnelEnv) save(setting, value string) {
	db, err := store.OpenWithKey(context.Background(), filepath.Join(e.home, "sessions.db"), "")
	require.NoError(e.t, err)
	require.NoError(e.t, store.NewSessionStore(db).SetSetting(context.Background(), setting, value))
	require.NoError(e.t, db.Close())
}

// start runs the server once and returns what eula_accepted events had arrived a moment after it answered; the server is stopped.
func (e *funnelEnv) start() []map[string]any {
	cfg := config.Load(e.home)
	cfg.Host = "127.0.0.1"
	cfg.Port = freePort(e.t)
	ctx, cancel := context.WithCancel(context.Background())
	rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
	require.NoError(e.t, err)
	time.Sleep(400 * time.Millisecond) // the window in which an event would arrive
	tracking.WaitForAsyncForTest()
	cancel()
	rs.Shutdown(5 * time.Second)
	rs.Close()
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]map[string]any(nil), e.sent...)
}

// #10106 (Security's LOW on #10004): the Coral app shows the terms in its own dialog and then starts the server as a child process, so the process that sends the event never saw the acceptance;
// it reads how from the marker the dialog wrote, on a first run only, once, and only with analytics on.
func TestEULAAcceptedForAServerTheAppStartedFollowsTheMarker(t *testing.T) {
	accepted := func(t *testing.T, source string) {
		// the marker, as another process wrote it; this process kept no note of it
		require.NoError(t, license.WriteEULAMarker())
		license.TakeAcceptanceSource()
		if source != "dialog" {
			data, err := os.ReadFile(license.EULAMarkerPath())
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(license.EULAMarkerPath(), []byte(string(data[:len(data)-len("source=dialog\n")])+"source="+source+"\n"), 0o644))
		}
	}
	t.Run("a first run with analytics on: sent once, from the marker", func(t *testing.T) {
		e := newFunnelEnv(t)
		accepted(t, "dialog")
		got := e.start()
		require.Len(t, got, 1)
		assert.Equal(t, "dialog", got[0]["source"])
		assert.Len(t, e.start(), 1, "a second start sends nothing more")
	})
	t.Run("the marker's other sources are sent as they are", func(t *testing.T) {
		e := newFunnelEnv(t)
		accepted(t, "hub")
		got := e.start()
		require.Len(t, got, 1)
		assert.Equal(t, "hub", got[0]["source"])
	})
	t.Run("analytics off: nothing, and nothing later when they are turned on", func(t *testing.T) {
		e := newFunnelEnv(t)
		e.save("telemetry_enabled", "false")
		accepted(t, "dialog")
		assert.Empty(t, e.start())
		e.save("telemetry_enabled", "true")
		assert.Empty(t, e.start(), "an acceptance that happened while analytics were off is not announced at a later start")
	})
	t.Run("an install from before (it has had a tracked open): nothing at an upgrade", func(t *testing.T) {
		e := newFunnelEnv(t)
		accepted(t, "dialog")
		tracking.TrackInstallAsync() // the first tracked open: not a first run any more
		tracking.WaitForAsyncForTest()
		assert.Empty(t, e.start())
	})
	t.Run("no marker, no acceptance: nothing", func(t *testing.T) {
		e := newFunnelEnv(t)
		license.TakeAcceptanceSource()
		assert.Empty(t, e.start())
	})
}
