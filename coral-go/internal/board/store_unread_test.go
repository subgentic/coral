package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #11012: a copy another board sent @mentions its recipients, so it is a mention; it is not a LOCAL one (the turn-end hand-off holds the one but not the other).
func TestHasUnreadLocalMentionIgnoresCopiesFromAnotherBoard(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	_, err := s.Subscribe(ctx, "alpha", "Orch", "Orchestrator", "claude-t-11012", nil, "all")
	require.NoError(t, err)
	_, err = s.Subscribe(ctx, "alpha", "Lead", "Lead", "", nil, "all")
	require.NoError(t, err)

	_, _, err = s.PostCrossTeamMessage(ctx, CrossTeamPost{Origin: MessageOrigin{Board: "beta", Sender: "Boss", SenderRole: "Orchestrator", TargetBoard: "alpha"}, Mentions: []string{"Orch"}, Content: "act now"})
	require.NoError(t, err)
	any, err := s.HasUnreadMention(ctx, "alpha", "Orch")
	require.NoError(t, err)
	assert.True(t, any, "the copy mentions its recipient")
	local, err := s.HasUnreadLocalMention(ctx, "alpha", "Orch")
	require.NoError(t, err)
	assert.False(t, local, "but it is not a local mention")

	_, err = s.PostMessage(ctx, "alpha", "Lead", "@Orch a local one", nil)
	require.NoError(t, err)
	local, err = s.HasUnreadLocalMention(ctx, "alpha", "Orch")
	require.NoError(t, err)
	assert.True(t, local, "a same-board @mention is")
}
