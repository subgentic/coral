package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #10592: two teams' agents of one role (two Orchestrators) both read "Orchestrator" in All chats. A chat of a live agent says which team it is on, so its row can name it; an agent on no team says none.
func TestSessionListItemsNameTheTeamOfALiveAgent(t *testing.T) {
	s := NewSessionStore(openTestDB(t))
	ctx := context.Background()
	stamp := "2026-10-25T20:00:00Z"
	for _, c := range []struct{ id, board string }{{"orch-a", "alpha"}, {"orch-b", "beta"}, {"solo", ""}} {
		require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: c.id, SourceType: "claude", SourceFile: "/fixture/" + c.id, FirstTimestamp: &stamp, LastTimestamp: &stamp, MessageCount: 1}))
		ls := &LiveSession{SessionID: c.id, AgentName: "Orchestrator", AgentType: "claude", WorkingDir: "/fixture"}
		if c.board != "" {
			b := c.board
			ls.BoardName = &b
		}
		require.NoError(t, s.RegisterLiveSession(ctx, ls))
	}
	require.NoError(t, s.UpsertSessionIndex(ctx, &SessionIndex{SessionID: "ended", SourceType: "claude", SourceFile: "/fixture/ended", FirstTimestamp: &stamp, LastTimestamp: &stamp, MessageCount: 1})) // no live record
	res, err := s.ListSessionsPaged(ctx, SessionListParams{})
	require.NoError(t, err)
	teams := map[string]string{}
	for _, it := range res.Sessions {
		teams[it.SessionID] = it.BoardName
	}
	assert.Equal(t, map[string]string{"orch-a": "alpha", "orch-b": "beta", "solo": "", "ended": ""}, teams, "the team of each live agent's chat; none for an agent on no team or a session with no live record")
}
