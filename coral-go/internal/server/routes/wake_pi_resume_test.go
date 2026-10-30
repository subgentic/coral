package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #11092 (Pi parity row 10): a Pi agent woken after a Coral restart comes back in the same conversation: the wake starts Pi on the SAME session folder (pi-sessions/<Coral session id>) with --continue.
// Pi itself picks the folder's last session up (checked by hand: a new process with --session-dir D --continue answered a question about the earlier process's words, in the one session file).
func TestWakeBringsAPiAgentBackInItsOwnSessionFolder(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "33333333-4444-4555-8666-777777777777"
	fake := stubScript(t, filepath.Join(t.TempDir(), "mock-pi"), "#!/bin/sh\nexit 0\n")
	require.NoError(t, ss.SetSetting(ctx, agent.CLIPathSettingKey(at.Pi), fake))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: at.Pi, AgentName: "coral-go", WorkingDir: t.TempDir()}))
	require.NoError(t, ss.SetSessionSleeping(ctx, id, true))

	req := dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+id+"/wake", nil), map[string]string{"sessionID": id})
	rec := httptest.NewRecorder()
	h.WakeSession(rec, req)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"ok":true`, rec.Body.String())
	cmds := term.sentCommands()
	require.NotEmpty(t, cmds)
	cmd := cmds[len(cmds)-1]
	assert.Contains(t, cmd, filepath.Join("pi-sessions", id), "the wake keeps the session's own folder: "+flagsOnly(cmd))
	assert.Equal(t, 1, strings.Count(cmd, "--session-dir"), flagsOnly(cmd))
	assert.Contains(t, cmd, "--continue", "and asks Pi to continue what that folder holds: "+flagsOnly(cmd))
}
