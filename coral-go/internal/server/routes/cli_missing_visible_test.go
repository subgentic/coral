package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
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
	require.NoError(t, ss.SetSessionSleepingFor(context.Background(), missingWakeSID, store.SleepReasonCoralStopped)) // an agent Coral stopped
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
	require.NotNil(t, ls.StartFailure)
	assert.Equal(t, store.StartFailureCLIMissing, *ls.StartFailure)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonCoralStopped, *ls.SleepReason, "the sleep reason is kept: the failure has its own field")
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
	wantWords := map[string]string{
		store.StartFailureCLIMissing:     "CLI was not found",
		store.StartFailureUntrustedMount: "Windows will not open the folder",
		store.StartFailureCLIPath:        "CLI path in Settings > CLI paths can't be run",
	}
	for _, typ := range []string{"claude", "codex", "agy", "pi", "terminal-like-unknown"} {
		for _, err := range []error{
			&agent.CLINotFoundError{AgentType: typ, Binary: "x", InstallCommand: "npm i -g do-not-leak-this", InstallURL: "https://do-not-leak-this"},
			&agent.CLIUntrustedMountError{AgentType: typ, Binary: "x", Dir: `C:\Users\leaky-name\bin`},
			&agent.CLIPathError{AgentType: typ, Path: `C:\Users\leaky-name\codex.exe`, Err: assert.AnError},
		} {
			code, ok := startRefusal(err)
			require.True(t, ok)
			s := startFailureSentence(typ, code)
			assert.Contains(t, s, wantWords[code], "each reason has its own words: %s %s", typ, code)
			assert.True(t, strings.HasPrefix(s, "failed to start: "), s)
			assert.NotContains(t, s, "do-not-leak-this")
			assert.NotContains(t, s, "leaky-name")
			assert.NotContains(t, s, `\`, "no path")
			assert.Less(t, len(s), 300)
		}
	}
	assert.Contains(t, startFailureSentence("codex", store.StartFailureCLIMissing), "Settings > CLI paths > Codex to its codex")
	assert.Empty(t, startFailureSentence("codex", ""), "no failure, no sentence")
	_, ok := startRefusal(assert.AnError)
	assert.False(t, ok, "another error is not a refused start")
}

// The agent is fixed by putting the CLI where it is looked for and waking it: the reason clears, the agent runs.
func TestWakingAfterTheCLIIsFixedClearsFailedToStart(t *testing.T) {
	srv, _, _, ss := missingWakeFixture(t)
	ctx := context.Background()
	code, _ := postBody(t, srv+"/api/sessions/live/"+missingWakeSID+"/wake", map[string]any{})
	require.Equal(t, http.StatusUnprocessableEntity, code)
	ls, _ := ss.GetLiveSession(ctx, missingWakeSID)
	require.NotNil(t, ls.StartFailure)

	cliOnlyOnPath(t, "codex") // Settings > CLI paths, or an install, makes the CLI findable
	code, body := postBody(t, srv+"/api/sessions/live/"+missingWakeSID+"/wake", map[string]any{})
	require.Equal(t, http.StatusOK, code, "%v", body)
	ls, err := ss.GetLiveSession(ctx, missingWakeSID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, ls.IsSleeping)
	assert.Nil(t, ls.SleepReason)
	assert.Nil(t, ls.StartFailure, "no stale failed-to-start on a working agent")
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
	assert.Nil(t, ls.StartFailure)
}

// The Orchestrator's case: an agent Coral stopped, its start refused at the next Coral start (CLI missing), refused again at the one after (no second line), and woken once the CLI is fixed.
func TestAnAgentCoralStoppedIsRefusedWhileTheCLIIsMissingAndWakesOnceItIsFixed(t *testing.T) {
	cfg := config.Load(t.TempDir())
	_, h, _, ss := setupSessionsTestServerWithConfig(t, cfg)
	ctx := context.Background()
	h.autoWake.sleep = func(ctx context.Context, d time.Duration) bool { return ctx.Err() == nil }
	clock := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
	h.autoWake.now = func() time.Time { return clock }
	for _, ct := range []string{"claude", "codex", "agy", "gemini", "pi"} {
		require.NoError(t, ss.SetSetting(ctx, "cli_path_"+ct, ""))
	}
	noCLIAnywhere(t)
	agent.UntrustedMountDir = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { agent.UntrustedMountDir = untrustedMountDirReal })

	board, disp := "tm", "Codex Tester"
	wd := t.TempDir()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: missingWakeSID, AgentType: "codex", AgentName: "repo", WorkingDir: wd, BoardName: &board, DisplayName: &disp}))
	require.NoError(t, ss.SetSessionSleepingFor(ctx, missingWakeSID, store.SleepReasonCoralStopped))

	failedLines := func() int {
		n := 0
		for _, l := range boardLines(t, h, "tm") {
			if strings.Contains(l, "failed to start") {
				n++
			}
		}
		return n
	}
	for start := 1; start <= 2; start++ { // two Coral starts with the CLI still missing
		clock = clock.Add(3 * time.Hour) // a later Coral start: outside the crash-loop guard's hour
		h.AutoWakeAfterRestart(ctx)
		ls, err := ss.GetLiveSession(ctx, missingWakeSID)
		require.NoError(t, err)
		assert.EqualValues(t, 1, ls.IsSleeping, "start %d: still asleep", start)
		assert.Equal(t, store.SleepReasonCoralStopped, ptr.Value(ls.SleepReason), "start %d: it stays an agent Coral stopped", start)
		assert.Equal(t, store.StartFailureCLIMissing, ptr.Value(ls.StartFailure), "start %d", start)
		assert.Equal(t, 1, failedLines(), "start %d: the failure is on the board once, not once per start", start)
	}

	cliOnlyOnPath(t, "codex") // the person fixed it
	clock = clock.Add(3 * time.Hour)
	h.AutoWakeAfterRestart(ctx)
	ls, err := ss.GetLiveSession(ctx, missingWakeSID)
	require.NoError(t, err)
	assert.EqualValues(t, 0, ls.IsSleeping, "the next Coral start woke it")
	assert.Nil(t, ls.StartFailure, "and the failure is cleared")
	assert.Nil(t, ls.SleepReason)
	assert.Equal(t, 1, failedLines(), "no further line")
}
