package board_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
)

func TestTheAutomationSenderPrefixIsReservedInEveryWayOfWritingIt(t *testing.T) {
	for _, name := range []string{"Automation: prod-alerts", "automation:x", "AUTOMATION: x", "  Automation : x", "Automation：x", "A u t o m a t i o n: x", "Automation:"} {
		assert.True(t, board.ReservedMemberName(name), name)
	}
	for _, name := range []string{"Automation", "Automations: x", "Dev", "My Automation: x", "", "Auto: x"} {
		assert.False(t, board.ReservedMemberName(name), name)
	}
	assert.Equal(t, "Automation: prod alerts", board.AutomationSender("  prod   alerts "))
}

// No member is ever made with the name: every way to make one ends in subscribe.
func TestNoMemberCanTakeTheNameAnAutomationPostsUnder(t *testing.T) {
	bs, err := boardtest.Open(t.TempDir() + "/b.db")
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "p", "Automation: prod-alerts", "Agent", "claude-x", nil, "")
	assert.ErrorIs(t, err, board.ErrReservedMemberName)
	_, err = bs.Join(ctx, "p", "Dev", "Automation: boss", "claude-y", nil, "")
	assert.ErrorIs(t, err, board.ErrReservedMemberName, "nor a role")
	_, err = bs.Subscribe(ctx, "p", "Dev", "Developer", "claude-y", nil, "")
	assert.NoError(t, err)

	msg, err := bs.PostAutomationMessage(ctx, "p", "prod-alerts", "[via automation prod-alerts] 2 alerts firing")
	require.NoError(t, err)
	assert.Equal(t, "Automation: prod-alerts", msg.SubscriberID)
	require.NotNil(t, msg.Origin)
	assert.Equal(t, board.OriginAutomation, *msg.Origin)
	assert.False(t, msg.IsSystem)
}
