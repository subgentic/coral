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

// #11387 (QA's finding A): a nudge Coral held (a pause, the person typing) is told by the one summary line; the notifier then takes those messages as told and does
// not nudge them again, while a message that arrives after still gets its nudge.
func TestASummaryThatToldAHeldNudgeReplacesTheNextNudge(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	const sid = "11111111-1387-4000-8000-0000000000b1"
	sess := naming.SessionName("claude", sid)
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", sess, nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := bs.PostMessage(ctx, "p", "Lead", text, nil)
		require.NoError(t, err)
	}
	clock := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, &mockRuntime{}, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.now = func() time.Time { return clock }
	holding, toldOnce := true, false
	var typed []string
	n.deliverNudge = func(_ context.Context, _ AgentRuntime, _ *slog.Logger, _, _, _, _, text, _ string, _, _ bool, _ func(context.Context) bool) (bool, error) {
		if holding {
			return true, nil // held: not typed
		}
		typed = append(typed, text)
		return false, nil
	}
	agent := AgentInfo{AgentType: "claude", SessionID: sid, DisplayName: "Developer", AgentName: "dev"}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) { return []AgentInfo{agent}, nil })
	pass := func() {
		clock = clock.Add(time.Minute)
		require.NoError(t, n.runPassWith(ctx, nil, false))
	}

	post("@Dev one")
	post("@Dev two")
	pass() // held
	assert.Empty(t, typed)

	holding = false
	n.nudgeTold = func(id string) bool { // the summary line was typed for what was held: told once, as ptymanager.TakeBoardNudgeTold is
		first := id == sid && !toldOnce
		toldOnce = true
		return first
	}
	pass()
	assert.Empty(t, typed, "the summary told those two messages: no ordinary nudge for them")

	post("@Dev three") // newer
	pass()
	require.Len(t, typed, 1, "a message after the summary is nudged as always")
	assert.Contains(t, typed[0], "3 unread")
}

// ... and without a summary, a held nudge is still sent when the hold ends (nothing was told).
func TestAHeldNudgeWithNoSummaryIsStillSentWhenTheHoldEnds(t *testing.T) {
	ctx := context.Background()
	bs := testBoardStore(t)
	const sid = "11111111-1387-4000-8000-0000000000b2"
	_, err := bs.Subscribe(ctx, "p", "Dev", "Developer", naming.SessionName("claude", sid), nil, "all")
	require.NoError(t, err)
	_, err = bs.Subscribe(ctx, "p", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)
	_, err = bs.PostMessage(ctx, "p", "Lead", "@Dev one", nil)
	require.NoError(t, err)
	clock := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	n := NewBoardNotifier(bs, &mockRuntime{}, time.Second)
	n.SetIsPausedFn(func(string) bool { return false })
	n.now = func() time.Time { return clock }
	holding := true
	var typed []string
	n.deliverNudge = func(_ context.Context, _ AgentRuntime, _ *slog.Logger, _, _, _, _, text, _ string, _, _ bool, _ func(context.Context) bool) (bool, error) {
		if holding {
			return true, nil
		}
		typed = append(typed, text)
		return false, nil
	}
	n.SetDiscoverFn(func(context.Context) ([]AgentInfo, error) {
		return []AgentInfo{{AgentType: "claude", SessionID: sid, DisplayName: "Developer", AgentName: "dev"}}, nil
	})
	require.NoError(t, n.runPassWith(ctx, nil, false))
	holding = false
	clock = clock.Add(time.Minute)
	require.NoError(t, n.runPassWith(ctx, nil, false))
	assert.Len(t, typed, 1)
}
