package routes

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// #11936 (the tester's run): a Hermes agent that had replied had last_message null on its row, because the reader looks for a transcript file and Hermes keeps none. It is the newest message with text in the
// agent's own state.db, by the rules of the other agents' (a tool-only turn and what Coral typed into the agent are not one), redacted and cut as theirs are.
func TestHermesRowHasItsLastMessage(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-0000000057f5"
	hermesID := "local-" + strings.Repeat("d5", 32)
	team := "team-a"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "hermes", AgentName: "repo", WorkingDir: "/tmp/test", BoardName: &team}))
	w := writeHermesState(t, agent.HermesAgentHome(h.cfg.CoralDir(), team, sid))

	assert.Nil(t, lastMessageRow(h, sid, "/tmp/test", "hermes", false, true), "nothing said yet")
	require.NoError(t, transcriptlink.BindHermes(h.cfg.CoralDir(), sid, hermesID))
	assert.Nil(t, lastMessageRow(h, sid, "/tmp/test", "hermes", false, true), "bound, but no message yet")

	addHermesMsg(t, w, hermesID, "user", "what is in this folder?")
	addHermesMsg(t, w, hermesID, "assistant", "Two files:\n  main.go  and README.md")
	_, err := w.Exec(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', '', '[{"id":"c1","function":{"name":"terminal","arguments":"{}"}}]', 1788000001)`, hermesID)
	require.NoError(t, err)
	f := lastMessageRow(h, sid, "/tmp/test", "hermes", false, true)
	require.NotNil(t, f, "the newest turn is tool-only, so the one before it is the last message")
	assert.Equal(t, "assistant", f["role"])
	assert.Equal(t, "Two files: main.go and README.md", f["text"])
	assert.NotEmpty(t, f["at"])

	key := "sk-ant-api03-" + strings.Repeat("aB3_x9Z-", 11) + "AA"
	addHermesMsg(t, w, hermesID, "user", "my key is "+key)
	f = lastMessageRow(h, sid, "/tmp/test", "hermes", false, true)
	require.NotNil(t, f)
	assert.Equal(t, "user", f["role"])
	assert.NotContains(t, f["text"], key, "redacted as the other agents' are")
}
