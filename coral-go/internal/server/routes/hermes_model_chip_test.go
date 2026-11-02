package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #12039 (goal #192, slice C): a Hermes agent's model chip follows its session. Hermes keeps no transcript file, so the chip showed only the model Coral launched with, even when Hermes ran another (a typed
// name it did not know, a /model inside it). The model is the one in the session's row of the agent's own state.db, read by the same rules as its chat (its own home, its bound session, read only).
func TestHermesModelChipFollowsItsSession(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000012039"
	hermesID := "local-" + strings.Repeat("c7", 32)
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "repo", WorkingDir: "/tmp/test", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(h.cfg.CoralDir(), team, sid))

	entry := map[string]any{"agent_type": "hermes", "model": "typed-model", "thinking": "low"}
	h.addTranscriptModel(entry, sid, nil)
	assert.Equal(t, "launch", entry["model_source"], "nothing bound yet: the launch's model")
	assert.Equal(t, "typed-model", entry["model"])

	require.NoError(t, transcriptlink.BindHermes(h.cfg.CoralDir(), sid, hermesID))
	_, err := w.Exec(`INSERT INTO sessions (id, model, started_at) VALUES (?, 'provider/real-model', 1788000000)`, hermesID)
	require.NoError(t, err)

	entry = map[string]any{"agent_type": "hermes", "model": "typed-model", "thinking": "low"}
	h.addTranscriptModel(entry, sid, nil)
	assert.Equal(t, "provider/real-model", entry["model"], "the model Hermes runs, not the one asked for")
	assert.Equal(t, "transcript", entry["model_source"])
	assert.Equal(t, "low", entry["thinking"], "Hermes's state.db records no reasoning level: the one it was started with stays")
	assert.Empty(t, entry["thinking_actual"], "and it is not claimed as observed")

	_, err = w.Exec(`UPDATE sessions SET model = 'other/model' WHERE id = ?`, hermesID)
	require.NoError(t, err)
	entry = map[string]any{"agent_type": "hermes", "model": "typed-model"}
	h.addTranscriptModel(entry, sid, nil)
	assert.Equal(t, "other/model", entry["model"], "a change in the database shows (the cache is by the database's state)")

	other := map[string]any{"agent_type": "claude", "model": "claude-x"}
	h.addTranscriptModel(other, sid, nil)
	assert.Equal(t, "claude-x", other["model"], "another agent type never reads a Hermes home")
}

// A control character or a long text in the model column is the agent's own text, not a model name: it is never shown, and the chip keeps the launch's model.
func TestHermesModelChipTextIsBounded(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000012040"
	hermesID := "local-" + strings.Repeat("c8", 32)
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "repo", WorkingDir: "/tmp/test", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(h.cfg.CoralDir(), team, sid))
	require.NoError(t, transcriptlink.BindHermes(h.cfg.CoralDir(), sid, hermesID))
	_, err := w.Exec(`INSERT INTO sessions (id, model, started_at) VALUES (?, ?, 1788000000)`, hermesID, "m\x1b[31m"+strings.Repeat("x", 5000))
	require.NoError(t, err)

	entry := map[string]any{"agent_type": "hermes"}
	h.addTranscriptModel(entry, sid, nil)
	assert.NotEqual(t, "transcript", entry["model_source"], "text that is not a model name is not shown as one")
	shown, _ := entry["model"].(string)
	assert.NotContains(t, shown, "\x1b")
	entry = map[string]any{"agent_type": "hermes", "model": "typed-model"}
	h.addTranscriptModel(entry, sid, nil)
	assert.Equal(t, "typed-model", entry["model"], "the launch's model stays")
	assert.Equal(t, "launch", entry["model_source"])
}

// A Hermes agent has no live switch (#12039), and its restart starts a NEW conversation (#11956): the 409 must not say the conversation resumes, as it does for the other types.
func TestSwitchModelForHermesSaysToRestartAndThatTheConversationIsNew(t *testing.T) {
	r := newSwitchRig(t, "hermes")
	b, _ := json.Marshal(map[string]any{"session_id": r.sid, "agent_type": "hermes", "model": "provider/other-model"})
	code, out := dashboardPost(t, r.server.URL+"/api/sessions/live/"+r.name+"/model", json.RawMessage(b))
	assert.Equal(t, http.StatusConflict, code, out)
	assert.Contains(t, out, `"code":"needs_restart"`)
	assert.Contains(t, out, "starts a new conversation")
	assert.NotContains(t, out, "its conversation resumes")
	assert.Empty(t, r.typed(), "nothing is typed into Hermes's terminal")
}

// QA on #12039: the character rule and the byte cap each get a case of their own, so neither can be dropped while the other keeps the test green.
func TestHermesModelOKCharacterRuleAndByteCapSeparately(t *testing.T) {
	assert.True(t, hermesModelOK("provider/vendor-model_1.2:tag@x+y"), "the characters model names use")
	assert.False(t, hermesModelOK("short\x1b[31m"), "a control character alone (well under the cap) is not a model name")
	assert.False(t, hermesModelOK("two words"), "a space is not one")
	assert.False(t, hermesModelOK(""), "nothing is not one")
	assert.True(t, hermesModelOK(strings.Repeat("x", hermesModelMax)), "exactly the cap is shown")
	assert.False(t, hermesModelOK(strings.Repeat("x", hermesModelMax+1)), "one byte over the cap, all valid characters, is not")
}

// QA on #12039: the cache is by the database's state, so a model that changes after the first read shows on the next, and a read of an unchanged database is served from the cache.
func TestHermesModelCacheFollowsAChangeAfterTheFirstRead(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-000000012042"
	hermesID := "local-" + strings.Repeat("c9", 32)
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "repo", WorkingDir: "/tmp/test", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(h.cfg.CoralDir(), team, sid))
	require.NoError(t, transcriptlink.BindHermes(h.cfg.CoralDir(), sid, hermesID))
	_, err := w.Exec(`INSERT INTO sessions (id, model, started_at) VALUES (?, 'first/model', 1788000000)`, hermesID)
	require.NoError(t, err)

	assert.Equal(t, "first/model", h.hermesModel(sid))
	assert.Equal(t, "first/model", h.hermesModel(sid), "an unchanged database: the same answer")
	_, err = w.Exec(`UPDATE sessions SET model = 'second/model' WHERE id = ?`, hermesID)
	require.NoError(t, err)
	assert.Equal(t, "second/model", h.hermesModel(sid), "the model changed after the first read: the next read has it")
}
