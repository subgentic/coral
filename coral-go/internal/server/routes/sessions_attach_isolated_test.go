package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #17810 (Security's follow-up on #17492): a test or isolated server never opens a Terminal window on the desktop. The Attach button of an agent started on such a server is refused with the reason; ~/.coral's own
// server still opens it, and CORAL_ALLOW_DESKTOP_TERMINAL=1 allows it on an isolated one.
func TestAnIsolatedServerDoesNotOpenATerminalOnTheDesktop(t *testing.T) {
	var opened atomic.Int32
	old := openDesktopTerminal
	openDesktopTerminal = func(string) { opened.Add(1) }
	defer func() { openDesktopTerminal = old }()
	server, _, terminal, _ := setupSessionsTestServer(t)
	terminal.addSession("team", "/tmp/team")
	attach := func() (int, map[string]any) {
		req, err := http.NewRequest("POST", server.URL+"/api/sessions/live/team/attach", bytes.NewBufferString(`{"agent_type":"claude","session_id":"11111111-2222-4333-8444-555555555555"}`))
		require.NoError(t, err)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		var got map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&got)
		return resp.StatusCode, got
	}
	code, got := attach() // the test server's data folder is a temp folder, not ~/.coral
	assert.Equal(t, http.StatusConflict, code, "%v", got)
	assert.Equal(t, "isolated_server", got["code"])
	time.Sleep(200 * time.Millisecond) // sleep-ok: the open runs in a goroutine; it must not have been asked
	assert.Zero(t, opened.Load(), "no Terminal is opened by an isolated server")

	t.Setenv("CORAL_ALLOW_DESKTOP_TERMINAL", "1")
	code, got = attach()
	assert.Equal(t, http.StatusOK, code, "%v", got)
	require.Eventually(t, func() bool { return opened.Load() == 1 }, 3*time.Second, 20*time.Millisecond, "the opt-in opens it")
}

func TestOnlyTheOwnCoralFolderIsNotIsolated(t *testing.T) {
	home, err := os.UserHomeDir()
	require.NoError(t, err)
	assert.False(t, isolatedDataDir(filepath.Join(home, ".coral")))
	assert.False(t, isolatedDataDir(filepath.Join(home, ".coral")+string(filepath.Separator)), "a trailing slash is the same folder")
	assert.True(t, isolatedDataDir(t.TempDir()))
	assert.True(t, isolatedDataDir(filepath.Join(home, ".coral-test")))
	assert.True(t, isolatedDataDir(""))
}
