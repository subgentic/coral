package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #12040 (goal #192, slice D): a Hermes agent finds its own earlier words with `coral-agent history search` and reads the turns around a hit, as a Pi agent does (#11088). Hermes keeps no transcript file: its
// conversation is rows of the state.db in the agent's own Hermes home, read read-only (hermesdb). Before this the search answered "live transcript not found".
func TestAgentHistorySearch_HermesFindsItsOwnWords(t *testing.T) {
	env := setupAgentHistoryTestEnv(t)
	ctx := context.Background()
	env.handler.cfg.UseCoralDir(t.TempDir())
	const sid = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c71"
	hermesID := "local-" + strings.Repeat("ab", 32)
	team := "team-a"
	require.NoError(t, env.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Hermes, AgentName: "hermes-dev", WorkingDir: "/work/h", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(env.handler.cfg.CoralDir(), team, sid))
	addHermesMsg(t, w, hermesID, "user", "FIXTURE-USER-1 how do I list files?")
	addHermesMsg(t, w, hermesID, "assistant", "FIXTURE-ASSISTANT-2 use ls -la")
	addHermesMsg(t, w, hermesID, "user", "FIXTURE-USER-3 and hidden ones?")
	addHermesMsg(t, w, hermesID, "assistant", "FIXTURE-ASSISTANT-4 those start with a dot")
	require.NoError(t, transcriptlink.BindHermes(env.handler.cfg.CoralDir(), sid, hermesID))

	get := func(path string, into any) int {
		resp, err := http.Get(env.server.URL + path)
		require.NoError(t, err)
		defer resp.Body.Close()
		require.NoError(t, json.NewDecoder(resp.Body).Decode(into))
		return resp.StatusCode
	}
	var out AgentHistorySearchResponse
	require.Equal(t, http.StatusOK, get("/api/agent/history/search?session_id="+sid+"&query=FIXTURE-ASSISTANT-2", &out))
	assert.Equal(t, "complete", out.Status, "the Hermes conversation is available: %+v", out.Sessions)
	require.Equal(t, 1, out.TotalMatches)
	assert.Equal(t, "assistant", out.Results[0].Role)
	assert.Contains(t, out.Results[0].Excerpt, "FIXTURE-ASSISTANT-2 use ls")

	var outU AgentHistorySearchResponse
	require.Equal(t, http.StatusOK, get("/api/agent/history/search?session_id="+sid+"&query=FIXTURE-USER-3&roles=user", &outU))
	require.Equal(t, 1, outU.TotalMatches, "what the person said is found too")
	var ctxOut AgentHistoryContextResponse
	require.Equal(t, http.StatusOK, get(fmt.Sprintf("/api/agent/history/context?session_id=%s&message_index=%d&window=1", sid, outU.Results[0].MessageIndex), &ctxOut))
	found := false
	for _, m := range ctxOut.Messages {
		if m.IsTarget && strings.Contains(m.Content, "FIXTURE-USER-3") {
			found = true
		}
	}
	assert.True(t, found, "the target turn is in its context: %+v", ctxOut.Messages)
	assert.GreaterOrEqual(t, len(ctxOut.Messages), 2, "with a turn beside it")

	var none AgentHistorySearchResponse
	require.Equal(t, http.StatusOK, get("/api/agent/history/search?session_id="+sid+"&query=NO-SUCH-WORD-ANYWHERE", &none))
	assert.Zero(t, none.TotalMatches)
	assert.Equal(t, "complete", none.Status, "no match is not an unavailable transcript")
}

// An agent with no conversation recorded yet, and one whose home is gone (a Kill removes it: its words are not kept), is "unavailable" with the reason, never an error or another agent's words.
func TestAgentHistorySearch_HermesWithNoConversationSaysSo(t *testing.T) {
	env := setupAgentHistoryTestEnv(t)
	ctx := context.Background()
	env.handler.cfg.UseCoralDir(t.TempDir())
	const sid = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c72"
	team := "team-a"
	require.NoError(t, env.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Hermes, AgentName: "hermes-new", WorkingDir: "/work/h", BoardName: &team}))
	resp, err := http.Get(env.server.URL + "/api/agent/history/search?session_id=" + sid + "&query=anything")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out AgentHistorySearchResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	assert.Equal(t, "unavailable", out.Status)
	require.NotEmpty(t, out.Sessions)
	assert.Contains(t, out.Sessions[0].Error, "Hermes", "said in Hermes's words")
}

// A teammate's home is never read for this agent: the same Hermes id in another agent's state.db finds nothing.
func TestAgentHistorySearch_HermesNeverReadsATeammatesHome(t *testing.T) {
	env := setupAgentHistoryTestEnv(t)
	ctx := context.Background()
	env.handler.cfg.UseCoralDir(t.TempDir())
	const sid, mate = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c73", "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c74"
	hermesID := "local-" + strings.Repeat("cd", 32)
	team := "team-a"
	for _, id := range []string{sid, mate} {
		require.NoError(t, env.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: at.Hermes, AgentName: "h-" + id[len(id)-1:], WorkingDir: "/work/h", BoardName: &team}))
	}
	w := writeHermesState(t, agent.HermesAgentHome(env.handler.cfg.CoralDir(), team, mate))
	addHermesMsg(t, w, hermesID, "user", "TEAMMATE-ONLY-SECRET")
	require.NoError(t, transcriptlink.BindHermes(env.handler.cfg.CoralDir(), sid, hermesID))
	resp, err := http.Get(env.server.URL + "/api/agent/history/search?session_id=" + sid + "&query=TEAMMATE-ONLY-SECRET")
	require.NoError(t, err)
	defer resp.Body.Close()
	var out AgentHistorySearchResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	assert.Zero(t, out.TotalMatches)
}
