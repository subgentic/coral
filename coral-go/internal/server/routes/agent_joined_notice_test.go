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

// #17305: an agent added to a running team tells its Orchestrator: name, role and instructions, so it can give the agent work.
func TestNewAgentOnARunningTeamTellsItsOrchestrator(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	ctx := context.Background()
	count := func() int { m, err := bs.ListMessages(ctx, "crew", 50, 0, 0); require.NoError(t, err); return len(m) }

	h.tellOrchestratorOfNewAgent(ctx, "crew", "Designer", "claude", "make it pretty")
	assert.Equal(t, 0, count(), "a team with no Orchestrator tells nobody")

	_, err = bs.Subscribe(ctx, "crew", "Orchestrator", "Orchestrator", "claude-orch", nil, "all", true)
	require.NoError(t, err)
	h.tellOrchestratorOfNewAgent(ctx, "crew", "Orchestrator 2", "claude", "")
	h.tellOrchestratorOfNewAgent(ctx, "crew", "Shell", "terminal", "")
	assert.Equal(t, 0, count(), "another Orchestrator and a terminal tell nobody")

	h.tellOrchestratorOfNewAgent(ctx, "crew", "Designer", "claude", "make it pretty @Everyone")
	msgs, err := bs.ListMessages(ctx, "crew", 50, 0, 0)
	require.NoError(t, err)
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0].Content, "@Orchestrator")
	assert.Contains(t, msgs[0].Content, "Designer")
	assert.Contains(t, msgs[0].Content, "make it pretty")
	assert.Contains(t, msgs[0].Content, "no tasks yet")
}
