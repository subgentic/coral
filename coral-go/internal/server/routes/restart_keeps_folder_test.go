package routes

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// A restarted or resumed agent starts in the folder its session worked in (#12057, the Operator: coral-hub's Security Reviewer came back in ~ though the session it
// replaced worked in ~/Software/coral-hub). The folder its terminal is in NOW is not that folder: a terminal recovered after a crash is at the home folder (#10813), and
// before this the restart of an agent on no team (a team's home folder was the only override) and a resume took the terminal's. The stored folder wins while it exists.
func TestRestartStartsInTheFolderTheSessionWorkedIn(t *testing.T) {
	server, handler, term, ss := setupSessionsTestServer(t)
	_ = handler
	ctx := context.Background()
	worked, home := t.TempDir(), t.TempDir()
	const oldID = "restart-keeps-folder"
	oldName := naming.SessionName("claude", oldID)
	term.addSession(oldName, home) // the pane is at "~", as a recovered terminal is
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: oldID, AgentType: "claude", AgentName: "coral-hub", WorkingDir: worked}))

	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json", strings.NewReader(`{"session_id":"`+oldID+`","agent_type":"claude"}`))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	term.mu.Lock()
	defer term.mu.Unlock()
	assert.Equal(t, []string{worked}, term.restartDirs, "the pane was respawned where the session worked, not where its terminal was")
}

// With no stored folder the terminal's is all there is; a stored folder that is gone is not forced on the agent either.
func TestRestartFallsBackToTheTerminalsFolderWhenTheStoredOneIsGone(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	gone, there := t.TempDir()+"/deleted", t.TempDir()
	const oldID = "restart-folder-gone"
	oldName := naming.SessionName("claude", oldID)
	term.addSession(oldName, there)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: oldID, AgentType: "claude", AgentName: "x", WorkingDir: gone}))

	resp, err := http.Post(server.URL+"/api/sessions/live/"+oldName+"/restart", "application/json", strings.NewReader(`{"session_id":"`+oldID+`","agent_type":"claude"}`))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	term.mu.Lock()
	defer term.mu.Unlock()
	assert.Equal(t, []string{there}, term.restartDirs)
}

func TestResumeStartsInTheFolderTheSessionWorkedIn(t *testing.T) {
	_, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	worked, home := t.TempDir(), t.TempDir()
	const liveID = "6682ebdf-65a4-4396-8ef3-26ead8208b8b"
	const convID = "074efb1a-0000-4000-8000-000000000001"
	name := naming.SessionName("claude", liveID)
	term.addSession(name, home)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: liveID, AgentType: "claude", AgentName: "coral-hub", WorkingDir: worked}))

	p, fail := handler.resumeResolve(ctx, name, &resumeRequest{SessionID: convID, AgentType: "claude", CurrentSessionID: liveID})
	require.Nil(t, fail)
	assert.Equal(t, worked, p.workdir, "the resume starts where the session worked, not where its terminal is")
}
