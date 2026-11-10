package background

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #15066: an agent whose context compaction is overdue has its nudge held, so the /compact goes in before a nudge starts a turn; the hold is the compaction service's to end.
func TestANudgeIsHeldWhileACompactionIsOverdueAndGoesWhenTheHoldEnds(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	const sid = "11111111-5066-4000-8000-0000000000c1"
	sess := naming.SessionName("claude", sid)
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", sess, nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "p", "Lead", "@Dev look", nil)
	require.NoError(t, err)
	clock := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, &mockRuntime{}, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.now = func() time.Time { return clock }
	var typed []string
	n.deliverNudge = func(_ context.Context, _ AgentRuntime, _ *slog.Logger, _, _, _, _, text, _ string, _, _ bool, _ func(context.Context) bool) (bool, error) {
		typed = append(typed, text)
		return false, nil
	}
	holding := true
	n.SetNudgeHoldFn(func(name string) bool { return holding && name == sess })
	agent := AgentInfo{AgentType: "claude", SessionID: sid, DisplayName: "Developer", AgentName: "dev"}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return []AgentInfo{agent}, nil })
	pass := func() {
		clock = clock.Add(time.Minute)
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}
	pass()
	assert.Empty(t, typed, "held for the compaction")
	holding = false
	pass()
	require.Len(t, typed, 1, "the nudge goes once the hold ends: nothing is lost")
	assert.Contains(t, typed[0], "1 unread")
}
