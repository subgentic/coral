package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// A wake subscribes the agent again (#17318): a message it already read is not delivered a second time. The Orchestrator's stale "hold" after Wake team (walks 55 and 60) was asked whether Coral
// replays it; the board does not: the subscribe keeps the read cursor, and only what arrived after it is unread.
func TestResubscribingAtWakeKeepsTheReadCursor(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	const proj = "wake-board"
	_, err := s.Subscribe(ctx, proj, "Orchestrator", "Orchestrator", "claude-orch", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, proj, "Lead", "Lead", "claude-lead", nil, "mentions")
	require.NoError(t, err)
	_, err = s.PostMessage(ctx, proj, "Orchestrator", "@Lead hold, your assignment follows once the plan is approved", nil)
	require.NoError(t, err)
	n, err := s.CheckUnread(ctx, proj, "Lead")
	require.NoError(t, err)
	require.Equal(t, 1, n, "the hold is unread until the agent reads it")
	_, err = s.ReadMessages(ctx, proj, "Lead", 50)
	require.NoError(t, err)
	n, err = s.CheckUnread(ctx, proj, "Lead")
	require.NoError(t, err)
	require.Equal(t, 0, n, "read")

	// Sleep, then Wake: the launch subscribes the same agent again.
	_, err = s.Subscribe(ctx, proj, "Lead", "Lead", "claude-lead", nil, "mentions")
	require.NoError(t, err)
	n, err = s.CheckUnread(ctx, proj, "Lead")
	require.NoError(t, err)
	require.Equal(t, 0, n, "a woken agent is not told again about a message it read before it slept")

	_, err = s.PostMessage(ctx, proj, "Orchestrator", "@Lead the plan is approved: take #7", nil)
	require.NoError(t, err)
	n, err = s.CheckUnread(ctx, proj, "Lead")
	require.NoError(t, err)
	require.Equal(t, 1, n, "what arrives after the wake is delivered")
}
