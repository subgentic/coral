package routes

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #21677: a person who picks Full Access in Codex's own /permissions gets a second dialog, "Enable full access?", inside the terminal. Coral did not see it: no attention dot, no Needs you card, and a message typed
// meanwhile would have had its Enter pick "Yes, continue anyway". The screen below is the dialog of Codex 0.172, captured from a throwaway agent with its own CODEX_HOME (a fake provider, no sign-in): nothing of anyone's in it.
var codexFullAccessConfirmScreen = strings.Join([]string{
	"  >_ OpenAI Codex (v0.172.0)",
	"     /tmp/work",
	"",
	"  To get started, describe a task or try one of these commands:",
	"  /permissions - choose what Codex is allowed to do",
	"",
	"                          Enable full access?",
	"                          When Codex runs with full access, it can edit any file on your",
	"                          computer and run commands with network, without your approval.",
	"                          Exercise caution when enabling full access. This significantly",
	"                          increases the risk of data loss, leaks, or unexpected behavior.",
	"",
	"                        › 1. Yes, continue anyway  Apply full access for this session",
	"                          2. Cancel                Go back without enabling full access",
	"",
	"                          enter select · esc back",
	"",
	"› Ask Codex to do anything",
	"",
	"  fake default · /tmp/work",
}, "\n")

// The picker that comes before it, and the idle screen, are not the dialog.
const codexPermissionsPickerScreen = "  Update Model Permissions\n› 1. Ask for approval  Read and edit workspace files\n  2. Approve for me\n  3. Full Access       Use with caution\n  4. Read Only\n\n  enter select · esc back\n"

func TestCodexFullAccessConfirmIsFoundByItsWordsAndOnlyIt(t *testing.T) {
	assert.True(t, ptymanager.CodexFullAccessConfirmOnScreen(codexFullAccessConfirmScreen))
	assert.False(t, ptymanager.CodexFullAccessConfirmOnScreen(codexPermissionsPickerScreen), "the picker is a menu the person opened, not the confirmation")
	assert.False(t, ptymanager.CodexFullAccessConfirmOnScreen("› Ask Codex to do anything\n  fake default\n"))
	assert.False(t, ptymanager.CodexFullAccessConfirmOnScreen("Enable full access?\n1. Yes, continue anyway\n2. Cancel\n"), "an agent's own text with no open prompt is not it") // no selected row marker
}

func TestAnAgentAtCodexsFullAccessConfirmationIsHeldAndNeedsYou(t *testing.T) {
	t.Setenv("CLAUDE_PROJECTS_DIR", t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	cases := []struct {
		name, lastEvent, screen string
		held                    bool
	}{
		{"a new agent (no event yet)", "", codexFullAccessConfirmScreen, true},
		{"an idle agent that had already run", "stop", codexFullAccessConfirmScreen, true},
		{"an agent with a turn in flight is not read", "prompt_submit", codexFullAccessConfirmScreen, false},
		{"the picker before the confirmation is the person's own menu, not held", "stop", codexPermissionsPickerScreen, false},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, h, mock, ss := setupSessionsTestServer(t)
			h.terminal = paneScreenTerminal{mock}
			ctx := context.Background()
			sid := fmt.Sprintf("eeeeeeee-21677-4000-8000-%012d", i)
			name := naming.SessionName("codex", sid)
			mock.addSession(name, "/tmp/project")
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "codex", AgentName: "running", WorkingDir: "/tmp/project"}))
			if c.lastEvent != "" {
				_, err := h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: c.lastEvent, Summary: c.lastEvent})
				require.NoError(t, err)
			}
			set := func(s string) {
				mock.mu.Lock()
				mock.outputs[name] = s
				mock.mu.Unlock()
				h.startupScreens = loginScreens{stampDecides: true}
			}
			set(c.screen)
			st := h.deriveSingleSessionState(ctx, sid, 0)
			if !c.held {
				assert.NotEqual(t, "startup", st.WaitingKind, "not held by the confirmation")
				return
			}
			assert.True(t, st.NeedsInput, "the agent waits for the person")
			assert.Equal(t, "startup", st.WaitingKind)
			assert.Equal(t, fullAccessConfirmSummary, st.WaitingSummary)
			assert.Contains(t, st.WaitingSummary, "1. Yes, continue anyway", "its real options are named")
			assert.Contains(t, st.WaitingSummary, "2. Cancel")
			assert.Contains(t, st.WaitingSummary, "send 1 or 2 from here", "the dashboard's own 1 or 2 is accepted too (#21689)")
			set("  \u203a \n")
			st = h.deriveSingleSessionState(ctx, sid, 0)
			assert.False(t, st.NeedsInput, "the confirmation went: cleared")
		})
	}
}

// Coral never closes it for the person (Esc would be an answer they did not give).
func TestCodexFullAccessConfirmIsNeverClosedByCoral(t *testing.T) {
	assert.True(t, dialogScreenExcluded(codexFullAccessConfirmScreen))
	assert.False(t, dialogScreenExcluded(codexPermissionsPickerScreen))
}
