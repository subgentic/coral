package opencode

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A 1.x agent's history and last message come through the legacy route the manager's client uses for that version.
func TestAOneDotXAgentsHistoryAndLastMessageComeFromItsLegacyRoute(t *testing.T) {
	cfg, _ := stubConfig(t)
	cfg.Version = "1.19.5"
	m := NewManager(cfg)
	defer m.Close()
	_, err := m.Ensure(context.Background(), "agent-1", "", "", "")
	require.NoError(t, err)
	m.UseSession("agent-1", "ses_abc123")
	msgs, ok, err := m.AgentMessages(context.Background(), "agent-1")
	require.NoError(t, err)
	require.True(t, ok)
	require.Len(t, msgs, 1)
	assert.Equal(t, "hello from the 1.x stand-in", msgs[0].Text)
	waitFor(t, "the last message", func() bool {
		l, ok := m.AgentLastMessage("agent-1")
		return ok && l.Text == "hello from the 1.x stand-in"
	})
}
