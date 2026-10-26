package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #7809: mailbox archive affects the person's folders, never the agent's own
// transcript search or the indexer's writes.
func TestChatArchiveKeepsAgentHistoryAndIndex(t *testing.T) {
	env := setupAgentHistoryTestEnv(t)
	ctx := context.Background()
	const id = "00000000-0000-4000-8000-000000007809"
	work := filepath.Join(env.claudeHome, "mailbox-fixture")
	require.NoError(t, env.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "mailbox-worker", WorkingDir: work}))
	project := filepath.Join(env.claudeHome, transcriptlink.ClaudeProjectDirName(work))
	require.NoError(t, os.MkdirAll(project, 0700))
	file := filepath.Join(project, id+".jsonl")
	require.NoError(t, os.WriteFile(file, []byte(`{"type":"user","timestamp":"2026-10-25T20:00:00Z","message":{"content":"mailbox archive fixture"}}`+"\n"), 0600))
	yes := true
	require.NoError(t, env.ss.UpdateChatFlags(ctx, id, nil, &yes))
	// The indexer's existing writes still index an archived chat and keep the mailbox flag.
	require.NoError(t, env.ss.UpsertSessionIndex(ctx, &store.SessionIndex{SessionID: id, SourceType: "claude", SourceFile: file, MessageCount: 1}))
	require.NoError(t, env.ss.UpsertFTS(ctx, id, "mailbox archive fixture"))
	indexed, err := env.ss.GetIndexedSession(ctx, id)
	require.NoError(t, err)
	require.NotNil(t, indexed)
	require.Equal(t, 1, indexed.MessageCount)
	visible, err := env.ss.ListSessionsPaged(ctx, store.SessionListParams{})
	require.NoError(t, err)
	require.Zero(t, visible.Total)
	req, err := http.NewRequest("GET", env.server.URL+"/api/agent/history/search?session_id="+id+"&query=mailbox", nil)
	require.NoError(t, err)
	req.Header.Set(testAgentHeader, id)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	var out AgentHistorySearchResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	require.Equal(t, "complete", out.Status)
	require.Equal(t, 1, out.TotalMatches)
}
