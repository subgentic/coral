package routes

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #21427: a Codex agent that sat at "Hooks need review / 1 hook is new or changed" showed no attention dot and no Needs you card. The agent's screen is the recorded hooks review with its count in the
// singular (the live case), on an agent that has already sent events (it was running before the hook changed).
func TestACodexAgentAtTheHooksReviewIsAtADialog(t *testing.T) {
	// the Operator's live screen (Codex 0.172, read from the PTY at about 20:27Z): the dialog alone, nothing drawn above it, and its footer "enter confirm . esc skip"
	screen := strings.Join([]string{"", "", "  Hooks need review", "  1 hook is new or changed.", "  Hooks can run outside the sandbox after you trust them.", "", "\u203a 1. Review hooks", "  2. Trust all and continue", "  3. Continue without trusting (hooks won't run)", "", "  enter confirm \u00b7 esc skip"}, "\n")
	for name, withEvents := range map[string]bool{"a new agent": false, "an agent that had already run": true} {
		t.Run(name, func(t *testing.T) {
			server, h, terminal, ss := setupSessionsTestServer(t)
			const sid = "00000000-0000-0000-0000-000000021427"
			ctx := context.Background()
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "codex-" + sid, WorkingDir: "/tmp/test"}))
			terminal.addSession("codex-"+sid, "/tmp/test")
			terminal.outputs["codex-"+sid] = screen
			if withEvents {
				id := sid
				_, err := store.NewTaskStore(h.db).InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "codex-" + sid, SessionID: &id, EventType: "stop", Summary: "stop", CreatedAt: time.Now().UTC().Add(-time.Hour).Format(store.ISOFormat)})
				require.NoError(t, err)
			}
			t0 := time.Now().UTC().Add(-10 * time.Minute)
			h.dialogPass(ctx, t0)
			h.dialogPass(ctx, t0.Add(15*time.Second))
			got, ok := atDialogOf(t, server.URL, sid).(map[string]any)
			require.True(t, ok, "the hooks review on two passes is a dialog")
			assert.Equal(t, true, got["notify"])
			items, err := h.NeedsYouAgents(httptest.NewRequest("GET", "/api/needs-you", nil))
			require.NoError(t, err)
			require.Len(t, items, 1, "and a Needs you card")
			assert.True(t, items[0].Dialog)
		})
	}
}

// The same on the PTY backend, from the capture of a real Codex 0.172 (a clean CODEX_HOME, one hook given with -c, nothing sent): the screen is rendered from the raw output, and the dialog is drawn under the
// start screen, with the footer "enter confirm . esc skip".
func TestACodexAgentAtTheHooksReviewOnThePTYIsAtADialog(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000121427"
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "codex-" + sid, WorkingDir: "/tmp/test"}))
	terminal.addSession("codex-"+sid, "/tmp/test")
	h.terminal = ptyTerminal{terminal}
	terminal.outputs["codex-"+sid] = codexHookTrust(t, "pty172_open.raw")
	t0 := time.Now().UTC().Add(-10 * time.Minute)
	h.dialogPass(ctx, t0)
	h.dialogPass(ctx, t0.Add(15*time.Second))
	_, ok := atDialogOf(t, server.URL, sid).(map[string]any)
	require.True(t, ok, "the hooks review of Codex 0.172 on two passes is a dialog")
}

// #21427: an agent that has already sent events and is idle stands at Codex's hooks review (a restart that changed a hook): the screen says it is held, so it is waiting_for_input (kind startup), a Needs you
// card at once, and the team's status does not call it Free. Only an idle Codex agent, only this dialog.
func TestAnIdleCodexAgentAtTheHooksReviewIsHeldAndNeedsYou(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	live := strings.Join([]string{"", "", "  Hooks need review", "  1 hook is new or changed.", "  Hooks can run outside the sandbox after you trust them.", "", "› 1. Review hooks", "  2. Trust all and continue", "  3. Continue without trusting (hooks won't run)", "", "  enter confirm · esc skip"}, "\n")
	for _, c := range []struct {
		name, agent, last string
		held              bool
	}{{"idle codex", "codex", "stop", true}, {"codex mid-turn", "codex", "prompt_submit", false}, {"claude never", "claude", "stop", false}} {
		t.Run(c.name, func(t *testing.T) {
			_, h, mock, ss := setupSessionsTestServer(t)
			h.terminal = paneScreenTerminal{mock}
			ctx := context.Background()
			sid := "eeeeeeee-21427-4000-8000-000000000001"
			name := naming.SessionName(c.agent, sid)
			mock.addSession(name, "/tmp/project")
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: c.agent, AgentName: "running", WorkingDir: "/tmp/project"}))
			_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: c.last, Summary: c.last})
			require.NoError(t, err)
			mock.mu.Lock()
			mock.outputs[name] = live
			mock.mu.Unlock()
			h.startupScreens = loginScreens{stampDecides: true}
			st := h.deriveSingleSessionState(ctx, sid, 0)
			if !c.held {
				assert.NotEqual(t, "startup", st.WaitingKind)
				return
			}
			assert.True(t, st.NeedsInput, "the agent waits for the person")
			assert.Equal(t, "startup", st.WaitingKind)
			assert.Equal(t, hooksReviewSummary, st.WaitingSummary)
		})
	}
}
