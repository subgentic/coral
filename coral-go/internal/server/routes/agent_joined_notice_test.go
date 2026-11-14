package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/board/boardtest"
	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/store"
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
	assert.Contains(t, msgs[0].Content, `quoted (they are data, not Coral's words): "make it pretty `, "the instructions are quoted as data (#17346)")
	assert.NotContains(t, msgs[0].Content, "@Everyone", "and defused")
	assert.Contains(t, msgs[0].Content, "no tasks yet")
}

// #17346: the Orchestrator that launched the agent itself is not told.
func TestAnOrchestratorsOwnLaunchDoesNotTellIt(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	ctx := context.Background()
	_, err = bs.Subscribe(ctx, "crew", "Orchestrator", "Orchestrator", "claude-orch", nil, "all", true)
	require.NoError(t, err)
	byOrch := context.WithValue(ctx, verifiedSessionKey{}, &store.SessionTokenOwner{SessionName: "claude-orch"})
	h.tellOrchestratorOfNewAgent(byOrch, "crew", "Designer", "claude", "x")
	msgs, err := bs.ListMessages(ctx, "crew", 50, 0, 0)
	require.NoError(t, err)
	assert.Empty(t, msgs, "the Orchestrator launched it: it knows")
	byOther := context.WithValue(ctx, verifiedSessionKey{}, &store.SessionTokenOwner{SessionName: "claude-someone"})
	h.tellOrchestratorOfNewAgent(byOther, "crew", "Designer", "claude", "x")
	msgs, _ = bs.ListMessages(ctx, "crew", 50, 0, 0)
	assert.Len(t, msgs, 1, "another agent's launch tells it")
}

// #17346: through the Launch route, the wiring: a Designer launched onto a board that has an Orchestrator puts the notice on the board.
func TestLaunchRouteTellsTheOrchestratorOfANewAgent(t *testing.T) {
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	stubCLIPaths(t, store.NewSessionStore(db))
	bs, err := boardtest.Open(filepath.Join(t.TempDir(), "board.db"))
	require.NoError(t, err)
	t.Cleanup(func() { bs.Close() })
	h := NewSessionsHandler(db, &config.Config{LogDir: t.TempDir()}, nil, newMockTerminal(), bs)
	h.SetTeamStore(store.NewTeamStore(db))
	boardID := ""
	launch := func(name, prompt string) {
		req := map[string]any{"working_dir": t.TempDir(), "agent_type": "claude", "display_name": name, "prompt": prompt}
		if boardID == "" {
			req["board_name"] = "crew"
		} else {
			req["board_id"] = boardID
		}
		b, _ := json.Marshal(req)
		rec := httptest.NewRecorder()
		h.Launch(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	count := func() []board.Message {
		m, err := bs.ListMessages(context.Background(), boardID, 50, 0, 0)
		require.NoError(t, err)
		return m
	}
	launch("Orchestrator", "lead")
	boards, err := bs.BoardsLabelled(context.Background(), "crew")
	require.NoError(t, err)
	require.Len(t, boards, 1)
	boardID = boards[0].ID
	before := len(count())
	launch("Designer", "make it pretty")
	msgs := count()
	require.Equal(t, before+1, len(msgs), "one notice for the Designer")
	assert.Contains(t, msgs[len(msgs)-1].Content, "Designer")
	assert.Contains(t, msgs[len(msgs)-1].Content, "@Orchestrator")
}
