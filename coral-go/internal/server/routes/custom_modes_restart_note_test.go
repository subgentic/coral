package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #16624 (Security's INFO on #16589): a restart of an agent whose custom permission mode was deleted starts it in Default, and the reply says so, as a launch's does (custom_mode_note).
func TestARestartOfAnAgentWhoseCustomModeWasDeletedSaysItStartedInDefault(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	gone := "custom:bbbbbbbbbbbbbbbb"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: "restart-note-1", AgentType: "claude", AgentName: "coral-go", WorkingDir: t.TempDir(), PermissionMode: &gone}))
	name := "claude-restart-note-1"
	term.addSession(name, t.TempDir())
	b, _ := json.Marshal(map[string]any{"session_id": "restart-note-1", "agent_type": "claude"})
	req := dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+name+"/restart", bytes.NewReader(b)), map[string]string{"name": name})
	rec := httptest.NewRecorder()
	h.Restart(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var out map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
	assert.Contains(t, out["custom_mode_note"], "deleted", "the person is told: %v", out)
	assert.Contains(t, out["custom_mode_note"], "Default")
}
