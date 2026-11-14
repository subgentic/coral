package routes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
)

// A stopped agent that holds an in-progress task is seen after the bound, is on the live row and in the needs-you read, tells the Orchestrator once, and clears when it takes a turn (#16921).
func TestAStoppedAgentHoldingATaskIsStalled(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	h.SetBoardHandler(NewBoardHandler(h.bs))
	ctx := context.Background()
	team := "stall"
	reg := func(name, title string) string {
		sid := uuid.NewString()
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentName: name, AgentType: "claude", BoardName: &team, WorkingDir: "/tmp"}))
		_, err := h.bs.Subscribe(ctx, team, name, title, "claude-"+sid, nil, "all")
		require.NoError(t, err)
		terminal.addSession("claude-"+sid, "/tmp")
		_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: name, SessionID: &sid, EventType: "stop"})
		require.NoError(t, err)
		return sid
	}
	reg("lead", "Orchestrator")
	qa := reg("qa", "QA Engineer")
	idle := reg("idle", "Developer") // no task: never stalled
	_, err := h.bs.CreateTask(ctx, team, "Check the calculator", "", "high", "lead", "qa")
	require.NoError(t, err)
	_, err = h.bs.ClaimTask(ctx, team, "qa")
	require.NoError(t, err)

	start := time.Now()
	h.stalledPass(ctx, start.Add(time.Minute), stalledTaskAfter)
	require.Nil(t, h.stalls.field(qa), "one minute with no turn is not stalled yet")

	h.stalledPass(ctx, start.Add(3*time.Minute), stalledTaskAfter)
	f, _ := h.stalls.field(qa).(map[string]any)
	require.NotNil(t, f, "three minutes with no turn is stalled")
	require.EqualValues(t, 1, f["task_id"])
	require.Nil(t, h.stalls.field(idle), "an agent with no task in progress is not stalled")

	count := func() int {
		msgs, err := h.bs.ListMessages(ctx, team, 50, 0, 0)
		require.NoError(t, err)
		n := 0
		for _, m := range msgs {
			if m.IsSystem && strings.Contains(m.Content, "@lead") && strings.Contains(m.Content, "task #1") {
				n++
			}
		}
		return n
	}
	require.Equal(t, 1, count(), "the Orchestrator is told on the board, once")
	h.stalledPass(ctx, start.Add(4*time.Minute), stalledTaskAfter)
	require.Equal(t, 1, count(), "a later pass does not say it again")

	rows := []map[string]any{{"session_id": qa, "display_name": "QA Engineer", "board_project": team, "stalled_task": h.stalls.field(qa)}}
	items := needsYouAgentItems(rows, start)
	require.Len(t, items, 1)
	require.Equal(t, "Stopped with task #1 in progress", items[0].Line)

	_, err = h.ts.InsertAgentEvent(ctx, &store.AgentEvent{AgentName: "qa", SessionID: &qa, EventType: "tool_use"})
	require.NoError(t, err)
	h.stalledPass(ctx, start.Add(5*time.Minute), stalledTaskAfter)
	require.Nil(t, h.stalls.field(qa), "it clears when the agent takes a turn")
}
