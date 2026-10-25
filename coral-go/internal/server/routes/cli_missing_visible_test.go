package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #353: a wake nobody watches that is refused for a missing CLI shows on the agent: "Failed to start" (sleep reason cli_missing), one line on its board, nothing typed into its terminal.

const missingWakeSID = "44444444-5555-4666-8777-888888888888"

func missingWakeFixture(t *testing.T) (srv string, h *SessionsHandler, term *mockSessionTerminal, ss *store.SessionStore) {
	t.Helper()
	_, h, term, ss = noCodexFixture(t)
	r := chi.NewRouter()
	r.Post("/api/sessions/live/{sessionID}/wake", h.WakeSession)
	srv = httptestServer(t, r)
	wd := t.TempDir()
	board := "tm"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: missingWakeSID, AgentType: "codex", AgentName: "repo", WorkingDir: wd, BoardName: &board, IsSleeping: 1}))
	require.NoError(t, term.CreateSession(context.Background(), naming.SessionName("codex", missingWakeSID), wd))
	return srv, h, term, ss
}

func boardLines(t *testing.T, h *SessionsHandler, project string) []string {
	t.Helper()
	msgs, err := h.bs.ListMessages(context.Background(), project, 100, 0, 0)
	require.NoError(t, err)
	var out []string
	for _, m := range msgs {
		out = append(out, m.Content)
	}
	return out
}

func TestARefusedWakeMarksTheAgentFailedToStartAndPostsOneBoardLine(t *testing.T) {
	srv, h, term, ss := missingWakeFixture(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ { // retries of the same wake
		code, body := postBody(t, srv+"/api/sessions/live/"+missingWakeSID+"/wake", map[string]any{})
		requireCLINotFound(t, code, body, "wake")
	}
	ls, err := ss.GetLiveSession(ctx, missingWakeSID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonCLIMissing, *ls.SleepReason)
	assert.EqualValues(t, 1, ls.IsSleeping, "still asleep: nothing was relaunched")

	lines := boardLines(t, h, "tm")
	var mine []string
	for _, l := range lines {
		if strings.Contains(l, "failed to start") {
			mine = append(mine, l)
		}
	}
	require.Len(t, mine, 1, "one line for the refused wake, not one per retry: %v", lines)
	assert.Contains(t, mine[0], "the Codex CLI was not found")
	assert.Contains(t, mine[0], "Settings > CLI paths > Codex")
	assert.Less(t, len(mine[0]), 300, "bounded")
	nothingTyped(t, term, "a refused wake")
}

func TestTheWordsOfARefusedStartAreFixedAndCarryNoEnvironmentValue(t *testing.T) {
	t.Setenv("CORAL_TEST_SECRET_VALUE", "do-not-leak-this")
	t.Setenv("LOCALAPPDATA", `C:\Users\leaky-name\AppData\Local`)
	for _, typ := range []string{"claude", "codex", "agy", "pi", "terminal-like-unknown"} {
		for _, err := range []error{
			&agent.CLINotFoundError{AgentType: typ, Binary: "x", InstallCommand: "npm i -g do-not-leak-this", InstallURL: "https://do-not-leak-this"},
			&agent.CLIUntrustedMountError{AgentType: typ, Binary: "x", Dir: `C:\Users\leaky-name\bin`},
			&agent.CLIPathError{AgentType: typ, Path: `C:\Users\leaky-name\codex.exe`, Err: assert.AnError},
		} {
			s, ok := startRefusal(typ, err)
			require.True(t, ok)
			assert.NotContains(t, s, "do-not-leak-this")
			assert.NotContains(t, s, "leaky-name")
			assert.NotContains(t, s, `\`, "no path")
			assert.Less(t, len(s), 300)
		}
	}
	_, ok := startRefusal("codex", assert.AnError)
	assert.False(t, ok, "another error is not a refused start")
}

// The agent is fixed by putting the CLI where it is looked for and waking it: the reason clears, the agent runs.
func TestWakingAfterTheCLIIsFixedClearsFailedToStart(t *testing.T) {
	srv, _, _, ss := missingWakeFixture(t)
	ctx := context.Background()
	code, _ := postBody(t, srv+"/api/sessions/live/"+missingWakeSID+"/wake", map[string]any{})
	require.Equal(t, http.StatusUnprocessableEntity, code)
	ls, _ := ss.GetLiveSession(ctx, missingWakeSID)
	require.Equal(t, store.SleepReasonCLIMissing, *ls.SleepReason)

	cliOnlyOnPath(t, "codex") // Settings > CLI paths, or an install, makes the CLI findable
	code, body := postBody(t, srv+"/api/sessions/live/"+missingWakeSID+"/wake", map[string]any{})
	require.Equal(t, http.StatusOK, code, "%v", body)
	ls, err := ss.GetLiveSession(ctx, missingWakeSID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, ls.IsSleeping)
	assert.Nil(t, ls.SleepReason, "no stale failed-to-start on a working agent")
}

// A restart that is refused leaves a RUNNING agent running and unmarked: only a sleeping agent is marked.
func TestARefusedRestartOfARunningAgentLeavesItAlone(t *testing.T) {
	server, _, term, ss := noCodexFixture(t)
	ctx := context.Background()
	wd := t.TempDir()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{AgentName: "codex-live", AgentType: "codex", WorkingDir: wd, SessionID: "codex-live-1"}))
	term.addSession("codex-live", wd)
	code, body := postBody(t, server.URL+"/api/sessions/live/codex-live/restart", map[string]any{"session_id": "codex-live-1"})
	requireCLINotFound(t, code, body, "restart")
	ls, err := ss.GetLiveSession(ctx, "codex-live-1")
	require.NoError(t, err)
	assert.EqualValues(t, 0, ls.IsSleeping)
	assert.Nil(t, ls.SleepReason)
}
