package main

import (
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/hooks"
)

// #235: with nothing set, the commands look for Coral on the port the server itself listens on by default (8450 on Windows, where
// the commands used 8420 before).
func TestTheCommandsDefaultIsTheServersPort(t *testing.T) {
	t.Setenv("CORAL_URL", "")
	t.Setenv("CORAL_PORT", "")
	t.Setenv("CORAL_DATA_DIR", t.TempDir())
	server := config.Load()
	assert.Equal(t, "http://localhost:"+strconv.Itoa(server.Port), hooks.CoralBase())
	assert.Equal(t, hooks.CoralBase(), defaultCoralURL())
}

// The commands find the running server of their data folder from the address it recorded in its lock file, before the default;
// --url, CORAL_URL and CORAL_PORT still win, and an address that is not this computer's is never taken.
func TestTheCommandsFindTheRunningServerOfTheirDataFolder(t *testing.T) {
	t.Setenv("CORAL_URL", "")
	t.Setenv("CORAL_PORT", "")
	dir := t.TempDir()
	t.Setenv("CORAL_DATA_DIR", dir)
	def := defaultCoralURL()
	parse := func(args ...string) (*flag.FlagSet, *string, *string) {
		fs := flag.NewFlagSet("t", flag.ContinueOnError)
		base := fs.String("url", def, "")
		home := fs.String("home", "", "")
		require.NoError(t, fs.Parse(args))
		return fs, base, home
	}
	record := func(dir, text string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, config.ServerLockFile), []byte(text), 0o600))
	}
	// A recorded address is used only once it answers /api/health as a Coral and its process runs (config.VerifiedServer): these are real listeners, and this test's own PID.
	coral := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ok","version":"test"}`))
	}))
	t.Cleanup(coral.Close)
	live := strconv.Itoa(os.Getpid())

	fs, base, home := parse()
	assert.Equal(t, def, runningServerURL(fs, *base, *home), "nothing recorded: the default")

	record(dir, "4242\n")
	assert.Equal(t, def, runningServerURL(fs, *base, *home), "an older server's lock file, the PID only: the default")

	record(dir, live+"\n"+coral.URL+"\n")
	assert.Equal(t, coral.URL, runningServerURL(fs, *base, *home), "the recorded address, verified")
	record(dir, "4242\n"+coral.URL+"\n")
	assert.Equal(t, def, runningServerURL(fs, *base, *home), "a record whose process is not running is not taken")
	record(dir, live+"\nhttp://localhost:8476\n")
	assert.Equal(t, def, runningServerURL(fs, *base, *home), "an address that does not answer is not taken")

	other := t.TempDir()
	record(other, live+"\n"+coral.URL+"\n")
	fs, base, home = parse("--home", other)
	assert.Equal(t, coral.URL, runningServerURL(fs, *base, *home), "--home's server")

	fs, base, home = parse("--url", "http://localhost:1234")
	assert.Equal(t, "http://localhost:1234", runningServerURL(fs, *base, *home), "--url wins")

	fs, base, home = parse()
	t.Setenv("CORAL_PORT", "9999")
	assert.Equal(t, def, runningServerURL(fs, *base, *home), "CORAL_PORT wins (CoralBase already used it)")
	t.Setenv("CORAL_PORT", "")

	for _, bad := range []string{"http://example.com:8476", "http://10.0.0.5:8476", "http://user:pw@localhost:8476",
		"http://localhost:8476/x", "http://localhost", "file:///c:/x", "ftp://localhost:21"} {
		record(dir, "4242\n"+bad+"\n")
		assert.Equal(t, def, runningServerURL(fs, *base, *home), "%s is not taken", bad)
	}
}
