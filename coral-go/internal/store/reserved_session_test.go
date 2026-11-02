package store

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #12309 (Security's SHOULD on #12176): no live session can be registered under the id that holds the person's own pictures, or resume from it, so an agent's session can never be that id.
func TestNoLiveSessionCanBeRegisteredUnderTheReservedPictureID(t *testing.T) {
	db := openTestDB(t)
	ss := NewSessionStore(db)
	ctx := context.Background()
	reserved := naming.PersonPictureSessionID
	upper := "70657273-6F6E-4000-8000-706963747572"

	for name, ls := range map[string]*LiveSession{
		"as its own id":         {SessionID: reserved, AgentType: "claude", AgentName: "a"},
		"in capitals":           {SessionID: upper, AgentType: "claude", AgentName: "a"},
		"as the one it resumes": {SessionID: "11111111-1111-4111-8111-111111111111", AgentType: "claude", AgentName: "a", ResumeFromID: &reserved},
	} {
		err := ss.RegisterLiveSession(ctx, ls)
		require.ErrorIs(t, err, ErrReservedSessionID, name)
	}
	rows, err := ss.GetLiveSession(ctx, reserved)
	require.NoError(t, err)
	assert.Nil(t, rows, "nothing was stored")
	one, err := ss.GetLiveSession(ctx, "11111111-1111-4111-8111-111111111111")
	require.NoError(t, err)
	assert.Nil(t, one, "nor a session that resumes from it")

	// an ordinary session still registers
	require.NoError(t, ss.RegisterLiveSession(ctx, &LiveSession{SessionID: "22222222-2222-4222-8222-222222222222", AgentType: "claude", AgentName: "b"}))
}
