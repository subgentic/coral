package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #353: the operator's Codex tester showed PowerShell's raw "codex is not recognized": a restart, resume or wake with no cli_path and no codex on PATH typed the bare name. Every way
// of starting an agent now refuses first, with the 422 cli_not_found a new launch gives, and types nothing.

// noCodexFixture is a test server whose settings name no CLI and whose computer has none (PATH and the common install places empty).
func noCodexFixture(t *testing.T) (*httptest.Server, *SessionsHandler, *mockSessionTerminal, *store.SessionStore) {
	t.Helper()
	server, handler, term, ss := setupSessionsTestServer(t)
	for _, ct := range []string{"claude", "codex", "agy", "gemini", "pi"} {
		require.NoError(t, ss.SetSetting(context.Background(), "cli_path_"+ct, ""))
	}
	noCLIAnywhere(t)
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false } // this computer's real PATH may hold an untrusted folder (#340)
	t.Cleanup(func() { agent.UntrustedMountDir = untrustedMountDirReal })
	return server, handler, term, ss
}

var untrustedMountDirReal = agent.UntrustedMountDir

func postBody(t *testing.T, url string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func requireCLINotFound(t *testing.T, code int, body map[string]any, what string) {
	t.Helper()
	assert.Equal(t, http.StatusUnprocessableEntity, code, "%s: %v", what, body)
	assert.Equal(t, "cli_not_found", body["code"], "%s: %v", what, body)
	msg, _ := body["error"].(string)
	assert.Contains(t, msg, "codex CLI not found", what)
	assert.Contains(t, msg, "cli_path_codex", what)
}

func nothingTyped(t *testing.T, term *mockSessionTerminal, what string) {
	t.Helper()
	term.mu.Lock()
	defer term.mu.Unlock()
	for target, sent := range term.sent {
		assert.Empty(t, sent, "%s: nothing is typed into %s", what, target)
	}
}

func TestNoCodexAnywhereRefusesANewLaunch(t *testing.T) {
	server, _, term, _ := noCodexFixture(t)
	code, body := postBody(t, server.URL+"/api/sessions/launch", map[string]any{"working_dir": t.TempDir(), "agent_type": "codex"})
	requireCLINotFound(t, code, body, "launch")
	nothingTyped(t, term, "launch")
}

func TestNoCodexAnywhereRefusesATeamStart(t *testing.T) {
	server, _, term, _ := noCodexFixture(t)
	code, body := postBody(t, server.URL+"/api/sessions/launch-team", map[string]any{
		"board_name": "tm", "working_dir": t.TempDir(), "agent_type": "codex", "agents": []map[string]any{{"name": "A"}},
	})
	assert.NotEqual(t, http.StatusOK, code, "a team of agents whose CLI is nowhere does not start: %v", body)
	nothingTyped(t, term, "team start")
	text, _ := json.Marshal(body)
	assert.Contains(t, string(text), "codex CLI not found", "the member's error says why")
}

func TestNoCodexAnywhereRefusesARestart(t *testing.T) {
	server, _, term, ss := noCodexFixture(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{AgentName: "codex-sleepy", AgentType: "codex", WorkingDir: t.TempDir(), SessionID: "codex-sleep-1"}))
	require.NoError(t, ss.SetSessionSleeping(ctx, "codex-sleep-1", true))
	code, body := postBody(t, server.URL+"/api/sessions/live/codex-sleepy/restart", map[string]any{"session_id": "codex-sleep-1"})
	requireCLINotFound(t, code, body, "restart")
	nothingTyped(t, term, "restart")
}

func TestNoCodexAnywhereRefusesAResume(t *testing.T) {
	server, _, term, ss := noCodexFixture(t)
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{AgentName: "codex-sleepy", AgentType: "codex", WorkingDir: t.TempDir(), SessionID: "codex-sleep-1"}))
	code, body := postBody(t, server.URL+"/api/sessions/live/codex-sleepy/resume", map[string]any{"session_id": "11111111-2222-4333-8444-555555555555", "agent_type": "codex", "current_session_id": "codex-sleep-1"})
	requireCLINotFound(t, code, body, "resume")
	nothingTyped(t, term, "resume")
}

func TestNoCodexAnywhereRefusesAWake(t *testing.T) {
	_, handler, term, ss := noCodexFixture(t)
	ctx := context.Background()
	r := chi.NewRouter()
	r.Post("/api/sessions/live/{sessionID}/wake", handler.WakeSession)
	srv := httptestServer(t, r)
	sid := "22222222-3333-4444-8555-666666666666"
	wd := t.TempDir()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "repo", WorkingDir: wd, IsSleeping: 1}))
	require.NoError(t, term.CreateSession(ctx, naming.SessionName("codex", sid), wd))
	code, body := postBody(t, srv+"/api/sessions/live/"+sid+"/wake", map[string]any{})
	requireCLINotFound(t, code, body, "wake")
	nothingTyped(t, term, "wake")
	still, _ := archFlags(t, ss, sid)
	assert.Equal(t, 1, still, "a refused wake leaves the agent asleep")
}

// A codex planted in a folder an agent writes to is not a CLI to start: the common install places are screened like a configured path (Security's #3019).
func TestACodexInTheTempFolderOrAnAgentsFolderIsNotPickedUpFromACommonPlace(t *testing.T) {
	_, handler, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	noCLIAnywhere(t)
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { agent.UntrustedMountDir = untrustedMountDirReal })

	// The common place of this computer is a folder inside an agent's working folder. On Unix the working folder is ~/.local, a folder BELOW the home folder: an agent working in the home folder
	// itself is no refusal (the home folder holds every install, #11454), one working in a folder that holds the place is.
	work := t.TempDir()
	home := ""
	if runtime.GOOS != "windows" {
		home = t.TempDir()
		work = filepath.Join(home, ".local")
		require.NoError(t, os.MkdirAll(work, 0o755))
	}
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "33333333-4444-4555-8666-777777777777", AgentType: "claude", AgentName: "w", WorkingDir: work}))
	var dir, name string
	if runtime.GOOS == "windows" {
		local := filepath.Join(work, "AppData", "Local")
		t.Setenv("LOCALAPPDATA", local)
		dir, name = filepath.Join(local, "npm"), "codex.cmd"
	} else {
		t.Setenv("HOME", home)
		dir, name = filepath.Join(work, "bin"), "codex"
	}
	require.NoError(t, os.MkdirAll(dir, 0o755))
	body := "#!/bin/sh\nexit 0\n"
	if runtime.GOOS == "windows" {
		body = "@exit /b 0\r\n"
	}
	require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755))

	// The agent's-folder screen on its own (the temp folder check below is a second, separate one):
	prevTemp := cliTempDirs
	cliTempDirs = func() []string { return nil } // the tests run in a temp folder; the check below is for the working folder alone
	t.Cleanup(func() { cliTempDirs = prevTemp })
	assert.Contains(t, handler.commonPlaceScreen(ctx)(filepath.Join(dir, name)), "in an agent's working folder") // the wording after it names the agent and the way out (#11454)
	assert.Empty(t, handler.commonPlaceScreen(ctx)(filepath.Join(t.TempDir(), "elsewhere")), "a folder no agent works in passes the screen")
	// Unscreened it would be found (the file is there, runnable), so the refusals below are the screens' doing.
	assert.NotEmpty(t, agent.FindCLIInCommonPaths("codex"), "the planted file is in a common place")
	_, err := agent.LaunchCLIScreened(nil, "codex", handler.commonPlaceScreen(ctx))
	var nf *agent.CLINotFoundError
	require.ErrorAs(t, err, &nf, "an agent's own folder is not a place to pick a CLI from")
	_, err = resolveLaunchCLIScreened("codex", "", handler.commonPlaceScreen(ctx))
	require.ErrorAs(t, err, &nf)
	// The same file in the system temp folder is refused without any screen.
	assert.True(t, agent.InTempFolder(filepath.Join(dir, name)), "the test's folders are in the temp folder")
	assert.Empty(t, agent.CommonPlaceCLI("codex", nil), "a CLI in the temp folder is not picked up from a common place")
}
