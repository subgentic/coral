package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

func tokenRig(t *testing.T) (*SessionsHandler, *store.SessionStore, string, string, func(string) string) {
	t.Helper()
	server, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	team := "tokcheck"
	const sid = "6682ebdf-65a4-4396-8ef3-26ead8208b8d"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "orch", BoardName: &team, WorkingDir: "/tmp"}))
	_, err := h.bs.Subscribe(ctx, team, "orch", "Orchestrator", naming.SessionName("claude", sid), nil, "all")
	require.NoError(t, err)
	term.addSession(naming.SessionName("claude", sid), "/tmp") // an awake agent is a live terminal: the list draws its row from it
	listed := func(key string) string {                        // the live list's field for the session
		resp, err := http.Get(server.URL + "/api/sessions/live")
		require.NoError(t, err)
		defer resp.Body.Close()
		var rows []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
		for _, r := range rows {
			if r["session_id"] == sid {
				s, _ := r[key].(string)
				return s
			}
		}
		return ""
	}
	return h, ss, sid, team, listed
}

// A woken agent whose token a later launch line replaced is told once (#12291): in the log, on its board and in the live list; one whose token is still the live one is not.
func TestWakeTokenCheckSaysWhenTheTokenWasReplaced(t *testing.T) {
	h, _, sid, team, listed := tokenRig(t)
	ctx := context.Background()
	t.Cleanup(func() { forgetTokenProblem(sid) })
	_, err := h.db.MintSessionToken(ctx, sid, naming.SessionName("claude", sid))
	require.NoError(t, err)
	live0, err := h.db.LiveSessionTokenCreated(ctx, sid)
	require.NoError(t, err)
	require.NotEmpty(t, live0)

	h.checkWakeToken(sid, "claude", live0)
	assert.Equal(t, "", listed("coral_token_problem"), "the token the agent was started with is still the live one: nothing to say")

	_, err = h.db.MintSessionToken(ctx, sid, naming.SessionName("claude", sid)) // a second launch line: the first token is revoked
	require.NoError(t, err)
	h.checkWakeToken(sid, "claude", live0)
	assert.Equal(t, tokenProblemSentence, listed("coral_token_problem"))
	msgs, err := h.bs.ListMessages(ctx, team, 50, 0, 0)
	require.NoError(t, err)
	var told int
	for _, m := range msgs {
		if strings.Contains(m.Content, tokenProblemSentence) {
			told++
		}
	}
	assert.Equal(t, 1, told, "the board is told")

	forgetTokenProblem(sid) // the agent is started again
	assert.Equal(t, "", listed("coral_token_problem"))
}

// A token file still there some seconds after the line was typed means the shell never read it (a Codex agent's file stays by design).
func TestWakeTokenCheckSaysWhenTheFileWasNotRead(t *testing.T) {
	h, _, sid, _, listed := tokenRig(t)
	ctx := context.Background()
	t.Cleanup(func() { forgetTokenProblem(sid); agent.SessionTokenFileFor = nil })
	_, err := h.db.MintSessionToken(ctx, sid, naming.SessionName("claude", sid))
	require.NoError(t, err)
	live0, _ := h.db.LiveSessionTokenCreated(ctx, sid)
	file := filepath.Join(t.TempDir(), "t-abc")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0o600))
	agent.SessionTokenFileFor = func(string) string { return file }

	h.checkWakeToken(sid, "claude", live0)
	assert.Equal(t, tokenProblemSentence, listed("coral_token_problem"), "the file is still there")
	forgetTokenProblem(sid)
	h.checkWakeToken(sid, "codex", live0)
	assert.Equal(t, "", listed("coral_token_problem"), "a Codex agent's file stays")
	require.NoError(t, os.Remove(file))
	h.checkWakeToken(sid, "claude", live0)
	assert.Equal(t, "", listed("coral_token_problem"), "the shell took it")
}

// An agent that is asleep again has no token to be wrong.
func TestWakeTokenCheckLeavesASleepingAgentAlone(t *testing.T) {
	h, ss, sid, _, listed := tokenRig(t)
	ctx := context.Background()
	t.Cleanup(func() { forgetTokenProblem(sid) })
	_, err := h.db.MintSessionToken(ctx, sid, naming.SessionName("claude", sid))
	require.NoError(t, err)
	live0, _ := h.db.LiveSessionTokenCreated(ctx, sid)
	_, err = h.db.MintSessionToken(ctx, sid, naming.SessionName("claude", sid))
	require.NoError(t, err)
	require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
	h.checkWakeToken(sid, "claude", live0)
	assert.Equal(t, "", listed("coral_token_problem"))
}
