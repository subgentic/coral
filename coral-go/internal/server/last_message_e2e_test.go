package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11097: every row of GET /api/sessions/live carries last_message {role, text, at}: the newest message with text, cut at 140 characters and redacted. A sleeping agent has one too.
func TestLiveRowsCarryTheLastMessage(t *testing.T) {
	srv, ts, _ := strictServer(t, false)
	ctx := context.Background()
	ss := store.NewSessionStore(srv.db)

	claudeDir := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", claudeDir)
	sid := "eeeeeeee-1197-4000-8000-000000000001"
	project := filepath.Join(claudeDir, "proj")
	require.NoError(t, os.MkdirAll(project, 0o755))
	long := strings.Repeat("reply ", 60)
	lines := `{"type":"user","timestamp":"2026-10-29T10:00:00.000Z","message":{"content":"first question"}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-10-29T10:00:05.000Z","message":{"content":[{"type":"text","text":"` + long + ` sk-ant-api03-` + strings.Repeat("aB3_x9Z-", 11) + `AA"}]}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(project, sid+".jsonl"), []byte(lines), 0o644))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "dev", WorkingDir: "/w", IsSleeping: 1}))

	var none = "eeeeeeee-1197-4000-8000-000000000002" // a sleeping agent with no transcript yet
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: none, AgentType: "claude", AgentName: "fresh", WorkingDir: "/w", IsSleeping: 1}))

	resp, err := http.Get(ts.URL + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var rows []map[string]any
	var wrapped struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if json.Unmarshal(raw, &rows) != nil {
		require.NoError(t, json.Unmarshal(raw, &wrapped))
		rows = wrapped.Sessions
	}
	by := map[string]map[string]any{}
	for _, r := range rows {
		by[r["session_id"].(string)] = r
	}
	require.Contains(t, by, sid, string(raw))
	lm, ok := by[sid]["last_message"].(map[string]any)
	require.True(t, ok, "a sleeping agent's row has last_message: %v", by[sid]["last_message"])
	assert.Equal(t, "assistant", lm["role"])
	assert.Equal(t, "2026-10-29T10:00:05.000Z", lm["at"])
	text := lm["text"].(string)
	assert.Len(t, []rune(text), 140)
	assert.True(t, strings.HasPrefix(text, "reply reply"))
	assert.NotContains(t, string(raw), strings.Repeat("aB3_x9Z-", 3), "no part of a secret in the list")

	require.Contains(t, by, none)
	v, present := by[none]["last_message"]
	assert.True(t, present, "the field is always there")
	assert.Nil(t, v, "and null when there is no message")
}
