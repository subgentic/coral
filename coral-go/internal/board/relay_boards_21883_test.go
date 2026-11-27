package board

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21883: the Settings line says how many boards list a source server (and so accept a relayed message with the switch on).
func TestCountRelayBoardsCountsBoardsThatListASourceServer(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	n, err := s.CountRelayBoards(ctx)
	require.NoError(t, err)
	assert.Equal(t, 0, n)
	one, none := []string{"srv_aaaa1111"}, []string{}
	_, err = s.UpdateBoardSettings(ctx, "alpha", BoardSettingsUpdate{CrossTeamServers: &one})
	require.NoError(t, err)
	_, err = s.UpdateBoardSettings(ctx, "beta", BoardSettingsUpdate{CrossTeamServers: &one})
	require.NoError(t, err)
	_, err = s.UpdateBoardSettings(ctx, "gamma", BoardSettingsUpdate{CrossTeamServers: &none})
	require.NoError(t, err)
	n, err = s.CountRelayBoards(ctx)
	require.NoError(t, err)
	assert.Equal(t, 2, n, "two boards list a server; the one with an empty list does not count")
}
