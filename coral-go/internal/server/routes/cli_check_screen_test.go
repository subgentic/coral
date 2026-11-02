package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/pkg/tunnel"
)

// #12053 (the operator): the New agent picker showed agy as installed, found in ~/.local/bin, and a launch then refused it because an agent works in that folder. The CLI check gives a CLI found in a
// common place the same screen a launch gives it: found but not used, with the reason and the setting, never plainly found.
func TestCLICheckGivesACommonPlaceTheScreenALaunchGivesIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Unix common place is ~/.local/bin")
	}
	prevLook, prevTemp := cliLookPath, cliTempDirs
	t.Cleanup(func() { cliLookPath, cliTempDirs = prevLook, prevTemp })
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliTempDirs = func() []string { return nil } // the tests run in a temp folder; this is about the agent's working folder
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { agent.UntrustedMountDir = untrustedMountDirReal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(home, ".local", "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "agy"), []byte("#!/bin/sh\necho 1.4.12\n"), 0o755))
	h := newSystemHandlerForTest(t)

	out := cliCheck(t, h, "type=agy")
	assert.Equal(t, true, out["found"], "no agent works there: it is found and usable: %v", out)

	require.NoError(t, h.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "44444444-5555-4666-8777-888888888888", AgentType: "claude", AgentName: "w", WorkingDir: filepath.Join(home, ".local")}))
	out = cliCheck(t, h, "type=agy")
	assert.Equal(t, true, out["found"], "#12365: an agent works in ~/.local, a standard install folder: the launch uses it, so the check calls it installed: %v", out)
	assert.Empty(t, out["refused"])
	assert.NotContains(t, out, "install_note")
}

// Security's SHOULD on #12053: through Coral Hub the refusal's reason names an agent and its working folder; the answer carries only the generic words.
func TestCLICheckThroughTheHubDoesNotNameTheAgentOrItsFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Unix common place is ~/.local/bin")
	}
	prevLook, prevTemp := cliLookPath, cliTempDirs
	t.Cleanup(func() { cliLookPath, cliTempDirs = prevLook, prevTemp })
	cliLookPath = func(string) (string, error) { return "", assert.AnError }
	cliTempDirs = func() []string { return nil }
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { agent.UntrustedMountDir = untrustedMountDirReal })
	home := t.TempDir()
	t.Setenv("HOME", home)
	bin := filepath.Join(home, ".local", "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(bin, "agy"), []byte("#!/bin/sh\necho 1.4.12\n"), 0o755))
	h := newSystemHandlerForTest(t)
	require.NoError(t, h.ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: "55555555-6666-4777-8888-999999999999", AgentType: "claude", AgentName: "Secret Agent Name", WorkingDir: filepath.Join(home, ".local")}))
	req := httptest.NewRequest(http.MethodGet, "/api/system/cli-check?type=agy", nil)
	req = req.WithContext(context.WithValue(context.WithValue(req.Context(), callerKindKey{}, callerDashCookie), tunneledKey{}, true))
	req.Header.Set(tunnel.ViaHeader, "hub")
	rec := httptest.NewRecorder()
	h.CLICheck(rec, req)
	require.Equal(t, 200, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"found":true`, "#12365: a CLI in ~/.local/bin is used though an agent works in ~/.local")
	assert.NotContains(t, rec.Body.String(), "Secret Agent Name", "an agent's name does not go through the Hub")
	assert.NotContains(t, rec.Body.String(), ".local", "nor its folder")
}
