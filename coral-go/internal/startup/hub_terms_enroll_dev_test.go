//go:build dev && !windows

package startup

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/testguard"
	terms "github.com/subgentic/coral/pkg/license"
)

// A Hub that answers the bootstrap enrollment, recording what it was asked (a dev build may talk to a loopback http Hub).
type termsHub struct {
	srv  *httptest.Server
	mu   sync.Mutex
	asks []map[string]json.RawMessage
}

func newTermsHub(t *testing.T, termsVersion string) *termsHub {
	h := &termsHub{}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]json.RawMessage
		_ = json.Unmarshal(b, &body)
		if r.URL.Path == "/api/bootstrap/enroll" { // the connector that follows an enrollment calls the Hub on other paths
			h.mu.Lock()
			h.asks = append(h.asks, body)
			h.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"identity_id":"i1","server_id":"srv_1","server_token":"coralhub_srv_secret","hub_url":"`+h.srv.URL+`","mode":"view","terms_accepted":"`+termsVersion+`","state":"active"}`)
	}))
	t.Cleanup(h.srv.Close)
	return h
}

// asked is how many enrollments the Hub was asked for.
func (h *termsHub) asked() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.asks)
}

func isolatedTermsStart(t *testing.T, hub *termsHub) (*config.Config, string) {
	// The guard learns where the real ~/.coral is on its first check, before this test points HOME at a temp folder: the acceptance marker (always under HOME/.coral) is then written in the temp one.
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
	t.Setenv("CORAL_TELEMETRY_DISABLED", "1")
	t.Setenv("CORAL_CLOUD_URL", "")
	require.NoError(t, os.MkdirAll(filepath.Join(iso, "home"), 0o700))
	require.NoError(t, os.MkdirAll(home, 0o700))
	cred := filepath.Join(iso, "credential")
	require.NoError(t, os.WriteFile(cred, []byte("chb_0123456789abcdefABCDEF_-xyz\n"), 0o600))

	cfg := config.Load(home)
	cfg.Host = "127.0.0.1"
	cfg.Port = freePort(t)
	cfg.CloudURL = hub.srv.URL
	cfg.BootstrapFile = cred
	cfg.TermsViaHub = true
	return cfg, cred
}

// #9936: a start that left its Terms to the Hub enrolls first; once the Hub has confirmed exactly this terms version the acceptance is recorded (source hub) and the server starts and serves.
func TestAHubConfirmedTermsLetTheHeadlessStartGoOn(t *testing.T) {
	oldExit := exitProcess
	t.Cleanup(func() { exitProcess = oldExit })
	var exits []int
	exitProcess = func(code int) { exits = append(exits, code) }

	hub := newTermsHub(t, terms.EULAVersion)
	cfg, cred := isolatedTermsStart(t, hub)
	require.False(t, license.IsEULAAccepted(), "the terms are not accepted here")

	ctx, cancel := context.WithCancel(context.Background())
	rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
	if err != nil {
		cancel()
	}
	require.NoError(t, err)
	t.Cleanup(func() {
		cancel()
		rs.Shutdown(5 * time.Second)
		rs.Close()
	})
	assert.Empty(t, exits)
	assert.True(t, license.IsEULAAccepted(), "the Hub's confirmation recorded the acceptance")
	marker, err := os.ReadFile(license.EULAMarkerPath())
	require.NoError(t, err)
	assert.Contains(t, string(marker), "source=hub")
	assert.Contains(t, string(marker), "version="+terms.EULAVersion)
	assert.NoFileExists(t, cred, "the one-time credential was used up")

	c := &http.Client{Timeout: 5 * time.Second}
	require.Eventually(t, func() bool {
		resp, err := c.Get("http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/api/health")
		if err != nil {
			return false
		}
		resp.Body.Close()
		return resp.StatusCode == http.StatusOK
	}, 30*time.Second, 50*time.Millisecond, "the server answers once the terms are confirmed")
	assert.Equal(t, 1, hub.asked(), "the credential is redeemed once: the connector does not redeem it again")
	// ... and the outcome on record is the enrollment's, not a second look that found the machine already enrolled
	time.Sleep(300 * time.Millisecond) // the connector's goroutine would run its own bootstrap in this window; nothing to wait on when it must not
	settings, err := store.NewSessionStore(rs.DB).GetSettings(context.Background())
	require.NoError(t, err)
	assert.Contains(t, settings[cloud.BootstrapStatusSetting], `"status":"enrolled"`)
}

// A Hub that accepted another terms version confirms nothing: nothing is recorded, nothing starts, the process ends with the refusal's code.
func TestAnotherTermsVersionFromTheHubStartsNothing(t *testing.T) {
	oldExit, oldPrompt := exitProcess, promptTerms
	t.Cleanup(func() { exitProcess, promptTerms = oldExit, oldPrompt })
	var exits []int
	exitProcess = func(code int) { exits = append(exits, code) }
	promptTerms = func() bool { return false }

	hub := newTermsHub(t, "1999-01-01")
	cfg, _ := isolatedTermsStart(t, hub)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
	require.Error(t, err)
	assert.Nil(t, rs)
	assert.Equal(t, []int{1}, exits, "hub_refused ends with 1")
	assert.False(t, license.IsEULAAccepted(), "another version is never recorded as this one")
	conn, derr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)), time.Second)
	if derr == nil {
		conn.Close()
	}
	assert.Error(t, derr, "nothing listened")
}
