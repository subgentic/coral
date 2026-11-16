package routes

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #17343: the team page says whether the Orchestrator was told of an agent added to the team: not told with no Orchestrator or before it has read the notice, told after.
func TestTheTeamPageSaysWhetherTheTeamWasToldOfANewAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	ctx := context.Background()
	state := func(orch, who string) string {
		s, err := bs.JoinNoticeStates(ctx, "crew", orch)
		require.NoError(t, err)
		return s[who]
	}

	h.tellOrchestratorOfNewAgent(ctx, "crew", "Designer", "claude", "make it pretty")
	assert.Equal(t, "not_told", state("", "Designer"), "a team with no Orchestrator: nobody was told")

	_, err = bs.Subscribe(ctx, "crew", "Orchestrator", "Orchestrator", "claude-orch", nil, "all", true)
	require.NoError(t, err)
	h.tellOrchestratorOfNewAgent(ctx, "crew", "Writer", "claude", "write it")
	assert.Equal(t, "not_told", state("Orchestrator", "Writer"), "the notice is sent, the Orchestrator has not read it")
	_, err = bs.ReadMessages(ctx, "crew", "Orchestrator", 50, true)
	require.NoError(t, err)
	assert.Equal(t, "told", state("Orchestrator", "Writer"), "told once the Orchestrator has read it")
	assert.Equal(t, "not_told", state("Orchestrator", "Designer"), "the earlier agent had no notice to read")
	assert.Empty(t, state("Orchestrator", "Nobody"), "an agent that was not added through Add agent has no state")
}
