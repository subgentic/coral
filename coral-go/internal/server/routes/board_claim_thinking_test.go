package routes

import (
	"context"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/store/storetest"
)

// #8915: claiming a task through the API records the thinking level of the claiming agent's session; a session with no level, or a name that is no live session, records nothing.
func TestClaimingATaskRecordsTheSessionsThinkingLevel(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	db, err := storetest.Open(t, filepath.Join(t.TempDir(), "s.db"))
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })
	ss := store.NewSessionStore(db)
	lvl := "High"
	const withLevel, noLevel = "claude-0000002a-3864-4864-8864-00000000002a", "claude-0000002b-3864-4864-8864-00000000002b"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "0000002a-3864-4864-8864-00000000002a", AgentName: "a", AgentType: "claude", WorkingDir: "/w", Thinking: &lvl}))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "0000002b-3864-4864-8864-00000000002b", AgentName: "b", AgentType: "claude", WorkingDir: "/w"}))
	h.SetSessionThinkingLookup(SessionThinkingLookup(ss))
	_, err = h.bs.Subscribe(ctx, "team", "Thinker", "Dev", withLevel, nil, "mentions")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Plain", "Dev", noLevel, nil, "mentions")
	require.NoError(t, err)
	for who, want := range map[string]string{"Thinker": "high", "Plain": ""} {
		task, err := h.bs.CreateTask(ctx, "team", "Work of "+who, "", "high", "Thinker", who)
		require.NoError(t, err)
		r := postJSON(t, server.URL+"/api/board/team/tasks/claim", map[string]any{"subscriber_id": who, "task_id": task.ID})
		r.Body.Close()
		require.Equal(t, http.StatusOK, r.StatusCode, who)
		got, err := h.bs.ClaimThinking(ctx, "team", task.ID)
		require.NoError(t, err)
		assert.Equal(t, want, got, who)
	}
}
