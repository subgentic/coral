package startup

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
)

// #9936: a headless first start (a cloud machine with a Coral Hub credential and nobody at a terminal) takes its Terms from the Hub: the start goes on only when the bootstrap ended with
// the terms recorded as accepted; any other end stops it, non-zero, with the bootstrap's own code.
func TestHubTermsGate(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   string
		accepted bool
		code     int
		stop     bool
	}{
		{"enrolled and recorded", cloud.BootstrapEnrolled, true, 0, false},
		{"enrolled but nothing recorded", cloud.BootstrapEnrolled, false, 3, true},
		{"no credential after all", cloud.BootstrapNone, false, 3, true},
		{"unsafe file", cloud.BootstrapUnsafeFile, false, 2, true},
		{"credential refused", cloud.BootstrapInvalid, false, 2, true},
		{"no hub configured", cloud.BootstrapNoHub, false, 2, true},
		{"terms need a new consent", cloud.BootstrapTermsReconsent, false, 3, true},
		{"hub unreachable", cloud.BootstrapRetryLater, false, 4, true},
		{"already enrolled, no local acceptance", cloud.BootstrapIgnoredIdentity, false, 5, true},
		{"the hub's answer could not be used (another terms version)", cloud.BootstrapRefused, false, 1, true},
		{"already accepted by the time it ends", cloud.BootstrapRetryLater, true, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code, stop := hubTermsGate(cloud.BootstrapResult{Status: tc.status}, tc.accepted)
			assert.Equal(t, tc.stop, stop)
			assert.Equal(t, tc.code, code)
		})
	}
}

// A start that took its Terms locally is not touched: no database is needed, nothing is read.
func TestHubTermsFirstLeavesALocalAcceptanceAlone(t *testing.T) {
	code, ok := hubTermsFirst(context.Background(), nil, &config.Config{})
	assert.True(t, ok)
	assert.Zero(t, code)
}

// #9936: a start that left its Terms to the Hub enrolls BEFORE anything listens or starts, so a prod build serves nothing while the terms are unconfirmed. With no Hub to confirm them it ends,
// non-zero, with no listener bound.
func TestStartLeavingTheTermsToTheHubServesNothingWhenTheyAreNotConfirmed(t *testing.T) {
	oldExit, oldAccepted, oldPrompt := exitProcess, eulaAcceptedHere, promptTerms
	t.Cleanup(func() { exitProcess, eulaAcceptedHere, promptTerms = oldExit, oldAccepted, oldPrompt })
	var exits []int
	exitProcess = func(code int) { exits = append(exits, code) }
	eulaAcceptedHere = func() bool { return false }
	promptTerms = func() bool { return false } // nobody at a terminal

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

	cfg := config.Load(home)
	cfg.Host = "127.0.0.1"
	cfg.Port = freePort(t)
	cfg.CloudURL = "" // no Hub to confirm anything
	cfg.TermsViaHub = true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs, err := Start(ctx, cfg, Options{BackendType: "pty"})
	require.Error(t, err)
	assert.Nil(t, rs)
	assert.ErrorIs(t, err, errTermsNotConfirmed)
	assert.Equal(t, []int{2}, exits, "the process ends with the bootstrap's code for no Hub")

	conn, derr := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)), time.Second)
	if derr == nil {
		conn.Close()
	}
	assert.Error(t, derr, "nothing was listening: the terms came first")
}

// A person at a terminal can still accept the terms there when the Hub did not confirm them (a credential that cannot be used, a Hub that is down): the start asks as it always did, and goes on if they say yes.
func TestAPersonAtATerminalCanAcceptWhenTheHubDoesNot(t *testing.T) {
	oldAccepted, oldPrompt := eulaAcceptedHere, promptTerms
	t.Cleanup(func() { eulaAcceptedHere, promptTerms = oldAccepted, oldPrompt })
	eulaAcceptedHere = func() bool { return false }
	asked := 0
	promptTerms = func() bool { asked++; return true }

	home := t.TempDir()
	db, err := store.OpenWithKey(context.Background(), filepath.Join(home, "sessions.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	cfg := &config.Config{TermsViaHub: true} // no Hub configured: the Hub cannot confirm anything
	code, ok := hubTermsFirst(context.Background(), db, cfg)
	assert.True(t, ok, "they accepted in the terminal")
	assert.Zero(t, code)
	assert.Equal(t, 1, asked)

	promptTerms = func() bool { asked++; return false }
	code, ok = hubTermsFirst(context.Background(), db, cfg)
	assert.False(t, ok, "they declined, or there is no terminal")
	assert.Equal(t, 2, code)
}
