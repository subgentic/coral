package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// With no CORAL_URL, CORAL_HOST or CORAL_PORT (a person's plain terminal) coral-agent finds the running Coral by the address in its data folder's lock file (#256).
func TestAgentFindsTheRunningCoralFromItsLockFile(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" { // asked before the address from the lock file is trusted (config.VerifiedServer): not a counted request
			w.Write([]byte(`{"status":"ok","version":"test"}`))
			return
		}
		hits++
		w.Write([]byte(`{"tasks":[]}`))
	}))
	defer srv.Close()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "coral-server.lock"), []byte(strconv.Itoa(os.Getpid())+"\n"+srv.URL+"\n"), 0o600))

	code, stdout, stderr := runAgentEnv(t, "", []string{"CORAL_DATA_DIR=" + dir}, "task", "list")
	require.Equal(t, 0, code, stderr)
	assert.Contains(t, stdout, "No tasks found")
	assert.Equal(t, 1, hits, "the request went to the address in the lock file")
}
