package background

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// terminal subscribes a person's terminal in the team (New terminal, #266): a "terminal" session, idle at its prompt for idle; live=false is one that is not running.
func (h *checkHarness) terminal(name string, n int, idle time.Duration, live bool) {
	h.t.Helper()
	sid := fmt.Sprintf("%08d-0000-0000-0000-000000000000", n)
	_, err := h.s.Subscribe(context.Background(), "team", name, "Terminal", naming.SessionName("terminal", sid), nil, "all")
	require.NoError(h.t, err)
	if live {
		h.agents = append(h.agents, AgentInfo{AgentType: "terminal", SessionID: sid, DisplayName: name})
		h.sig[sid] = agentSignal{Since: h.now.Add(-idle)}
	}
}

// #21170 (Operator report): a terminal a person opens in a team is not an agent. A team with one agent and one terminal: only the agent gets items, and only the agent is counted.
func TestAPersonsTerminalInATeamGetsNoItemsAndIsNotCounted(t *testing.T) {
	for _, live := range []bool{true, false} {
		t.Run(fmt.Sprintf("live=%v", live), func(t *testing.T) {
			h := newCheckHarness(t)
			ctx := context.Background()
			h.member("Orchestrator", "Orchestrator", 1, 0)
			h.member("Agent", "Developer", 2, 30*time.Minute) // idle, with no work
			h.terminal("Shell", 3, 30*time.Minute, live)      // as idle, and a person's
			_, err := h.s.CreateTask(ctx, "team", "Terminal task", "", "medium", "Orchestrator", "Shell")
			require.NoError(t, err)
			out := h.check()
			assert.Contains(t, out, "Agent", "the idle agent is still an item")
			assert.NotContains(t, out, "Shell", "a person's terminal is not named in any item")
			assert.NotContains(t, out, "peek \"Shell\"", "nobody is told to peek a terminal")
			assert.NotContains(t, out, "1 offline", "a terminal that is not running is not an offline agent")
			assert.Contains(t, out, "1 idle", "one agent is idle, not two")
			assert.NotContains(t, out, "2 idle")
		})
	}
}
