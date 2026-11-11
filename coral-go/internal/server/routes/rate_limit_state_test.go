package routes

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #15485 (#15464 finding 3): Codex draws its "Approaching rate limits / Switch model?" notice after its hooks have started, on an idle agent. No event says so, the no-event startup read never sees it, and
// Coral's sends were skipped ("a prompt is open") with no Needs you row asking the person. The screen now says the agent is held (waiting_for_input, kind startup) and the row offers the notice's own choices
// (Keep current model is one of them); Coral never answers it. Only Codex, only an idle agent (a turn in flight is not read), only exactly this notice.
func TestCodexRateLimitNoticeHoldsAnIdleAgentAndNeedsYou(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	cases := []struct {
		name, agent, lastEvent, screen string
		held                           bool
	}{
		{"idle codex agent on the notice", "codex", "stop", rateLimitScreen, true},
		{"codex agent with a turn in flight is not read", "codex", "prompt_submit", rateLimitScreen, false},
		{"another menu on an idle codex agent", "codex", "stop", codexHookTrust(t, "tmux_open.txt"), false},
		{"the notice's title with a changed menu", "codex", "stop", "  Approaching rate limits\n  Switch to gpt-6-luna for lower credit usage?\n\n› 1. Switch to gpt-6-luna\n  2. Keep current model\n\n  Press enter to confirm or esc to go back\n", false},
		{"another agent type is never read for it", "claude", "stop", rateLimitScreen, false},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, h, mock, ss := setupSessionsTestServer(t)
			h.terminal = paneScreenTerminal{mock}
			ctx := context.Background()
			sid := fmt.Sprintf("eeeeeeee-15485-4000-8000-%012d", i)
			name := naming.SessionName(c.agent, sid)
			mock.addSession(name, "/tmp/project")
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: c.agent, AgentName: "running", WorkingDir: "/tmp/project"}))
			_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: c.lastEvent, Summary: c.lastEvent})
			require.NoError(t, err)
			set := func(s string) {
				mock.mu.Lock()
				mock.outputs[name] = s
				mock.mu.Unlock()
				h.startupScreens = loginScreens{stampDecides: true}
			}
			set(c.screen)
			st := h.deriveSingleSessionState(ctx, sid, 0)
			if !c.held {
				assert.NotEqual(t, "startup", st.WaitingKind, "not held by the notice")
				return
			}
			assert.True(t, st.NeedsInput, "the agent waits for the person")
			assert.Equal(t, "startup", st.WaitingKind)
			assert.Equal(t, rateLimitNoticeSummary, st.WaitingSummary)
			set("  › \n")
			st = h.deriveSingleSessionState(ctx, sid, 0)
			assert.False(t, st.NeedsInput, "the notice went: cleared")
		})
	}
}
