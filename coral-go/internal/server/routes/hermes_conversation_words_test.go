package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #11956 (QA INFO on #11936): a Hermes agent keeps its conversation in a Hermes home of its own, which a restart deletes (the agent has a new session id) and Hermes keeps no other copy. A restart says so in its
// answer, and a resume by a Hermes id, which a new agent's own home could never find, is refused with the reason instead of ending in "Session not found" in the pane.
func TestARestartOfAHermesAgentSaysItStartsANewConversation(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	for _, typ := range []string{"hermes", "claude"} {
		t.Run(typ, func(t *testing.T) {
			sid := map[string]string{"hermes": "00000000-0000-0000-0000-000000d10001", "claude": "00000000-0000-0000-0000-000000d10002"}[typ]
			if typ == "hermes" {
				require.NoError(t, ss.SetSetting(ctx, "cli_path_hermes", stubCLI(t)))
			}
			sn := naming.SessionName(typ, sid)
			require.NoError(t, term.CreateSession(ctx, sn, t.TempDir()))
			require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: typ, AgentName: "repo", WorkingDir: t.TempDir()}))
			body, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": typ})
			resp, err := http.Post(server.URL+"/api/sessions/live/"+sn+"/restart", "application/json", bytes.NewReader(body))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var res map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
			if typ == "hermes" {
				note, _ := res["conversation_note"].(string)
				assert.Contains(t, note, "new conversation")
				assert.Contains(t, note, "deleted")
			} else {
				assert.Nil(t, res["conversation_note"], "no other agent type has it")
			}
		})
	}
}

func TestAHermesLaunchOrResumeByAHermesIDIsRefusedWithTheReason(t *testing.T) {
	server, _, _, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	hermesID := "local-" + strings.Repeat("9f", 32)

	body, _ := json.Marshal(map[string]any{"agent_type": "hermes", "working_dir": t.TempDir(), "resume_session_id": hermesID})
	resp, err := http.Post(server.URL+"/api/sessions/launch", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	var res map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
	msg, _ := res["error"].(string)
	assert.Contains(t, msg, "Hermes")
	assert.Contains(t, msg, "own Hermes home")

	body, _ = json.Marshal(map[string]any{"session_id": hermesID, "agent_type": "hermes", "current_session_id": "00000000-0000-0000-0000-000000d10003"})
	resp2, err := http.Post(server.URL+"/api/sessions/live/hermes-x/resume", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer resp2.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp2.StatusCode)
	res = map[string]any{}
	require.NoError(t, json.NewDecoder(resp2.Body).Decode(&res))
	msg, _ = res["error"].(string)
	assert.Contains(t, msg, "own Hermes home")
}
