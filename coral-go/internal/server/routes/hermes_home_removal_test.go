package routes

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
)

// #11936: a Hermes agent has a home of its own (its state.db, hooks, .env: about 400 MB once prepared). Deleting the agent removes that home, and only that one; another agent's stays.
func TestKillingAHermesAgentRemovesItsOwnHomeOnly(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid, mate = "00000000-0000-0000-0000-0000000057f2", "00000000-0000-0000-0000-0000000057f3"
	team := "team-a"
	ctx := context.Background()
	for _, id := range []string{sid, mate} {
		require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "hermes", AgentName: "repo-" + id[len(id)-2:], WorkingDir: "/tmp/test", BoardName: &team}))
		terminal.addSession("hermes-"+id, "/tmp/test")
		require.NoError(t, os.MkdirAll(agent.HermesAgentHome(h.cfg.CoralDir(), team, id), 0o700))
		require.NoError(t, os.WriteFile(agent.HermesAgentHome(h.cfg.CoralDir(), team, id)+"/state.db", []byte("x"), 0o600))
	}
	resp, err := http.Post(server.URL+"/api/sessions/live/hermes-"+sid+"/kill", "application/json", bytes.NewBufferString(`{"agent_type":"hermes","session_id":"`+sid+`"}`))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	_, err = os.Stat(agent.HermesAgentHome(h.cfg.CoralDir(), team, sid))
	assert.True(t, os.IsNotExist(err), "the deleted agent's home is gone")
	_, err = os.Stat(agent.HermesAgentHome(h.cfg.CoralDir(), team, mate) + "/state.db")
	assert.NoError(t, err, "the teammate's home stays")
}

// A restart or a resume gives the agent a new session id, and so a new home: the replaced session's own is removed (by its team and its id), and nothing is touched for another agent type or an unknown session.
func TestAReplacedSessionsHermesHomeIsRemoved(t *testing.T) {
	_, h, _, _ := setupSessionsTestServer(t)
	const oldID = "00000000-0000-0000-0000-0000000057f6"
	team := "team-a"
	home := agent.HermesAgentHome(h.cfg.CoralDir(), team, oldID)
	prepare := func() {
		require.NoError(t, os.MkdirAll(home, 0o700))
		require.NoError(t, os.WriteFile(home+"/state.db", []byte("x"), 0o600))
	}
	prepare()
	h.removeReplacedHermesHome(nil, team, oldID)
	h.removeReplacedHermesHome(&store.LiveSession{SessionID: oldID, AgentType: "claude", BoardName: &team}, team, oldID)
	_, err := os.Stat(home + "/state.db")
	assert.NoError(t, err, "an unknown session or another agent type: nothing removed")
	h.removeReplacedHermesHome(&store.LiveSession{SessionID: oldID, AgentType: "hermes", BoardName: &team}, "", oldID)
	_, err = os.Stat(home)
	assert.True(t, os.IsNotExist(err), "the replaced Hermes session's home is gone, by its stored team")
}
