package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #137219 (the Windows team's WSL live run, QA on macOS): after a restart a mentions-only subscriber with nothing unread was never nudged for a fresh @-mention (until the 15 minute reminder);
// the startup seed counted it as already notified.
func TestBoardNotifier_AMentionsOnlySubscriberIsNudgedAfterARestart(t *testing.T) {
	bs := testBoardStore(t)
	rt := &mockRuntime{}
	ctx := context.Background()
	_, err := bs.Subscribe(ctx, "proj", "Orchestrator", "Orchestrator", "claude-orch-0001", nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "proj", "Worker", "Worker", "claude-work-0002", nil, "mentions")
	require.NoError(t, err)
	agents := []AgentInfo{
		{AgentName: "orch", AgentType: "claude", SessionID: "orch-0001", DisplayName: "Orchestrator"},
		{AgentName: "worker", AgentType: "claude", SessionID: "work-0002", DisplayName: "Worker"},
	}
	n := NewBoardNotifier(bs, rt, 10*time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return agents, nil })
	n.SeedFromDB(ctx) // the restart: nothing unread for either

	_, err = bs.PostMessage(ctx, "proj", "Orchestrator", "@Worker please look at this", nil)
	require.NoError(t, err)
	n.NotifyBoard("proj")
	require.NoError(t, n.RunOnce(ctx))
	var to []string
	for _, s := range rt.sent {
		to = append(to, s.session)
	}
	assert.Contains(t, to, "claude-work-0002", "the mentioned worker is nudged at once, not after the reminder window: %v", rt.sent)
}
