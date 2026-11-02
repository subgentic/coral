package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #12481 (Security, safety): the mode picked in the Restart dialog wins over the stored mode and the stored permission flags, both ways. Before, restartFlags stripped the dialog's flag and re-applied what was stored:
// Default to Bypass sent nothing, and Bypass to Default kept the stored skip-prompts flag (no prompts although the person chose them). A restart that picks nothing keeps what it had.
func TestARestartWithAPickedModeRestartsInIt(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	str := func(s string) *string { return &s }
	for i, c := range []struct {
		name, agent string
		stored      *string
		flags       []string
		pick        *string
		wantMode    string
		has, lacks  string
	}{
		{"claude bypass to default", "claude", str("bypassPermissions"), nil, str("default"), "default", "--permission-mode default", "dangerously-skip-permissions"},
		{"claude default to bypass", "claude", str("default"), nil, str("bypassPermissions"), "bypassPermissions", "--permission-mode bypassPermissions", ""},
		{"claude bypass by flag only to default", "claude", nil, []string{"--dangerously-skip-permissions"}, str("default"), "default", "--permission-mode default", "dangerously-skip-permissions"},
		{"codex bypass to default", "codex", str("bypassPermissions"), []string{"--dangerously-bypass-approvals-and-sandbox"}, str("default"), "default", "", "dangerously-bypass-approvals-and-sandbox"},
		{"codex default to bypass", "codex", str("default"), nil, str("bypassPermissions"), "bypassPermissions", "--dangerously-bypass-approvals-and-sandbox", ""},
		{"claude no pick keeps the stored bypass", "claude", str("bypassPermissions"), nil, nil, "bypassPermissions", "--permission-mode bypassPermissions", ""},
		{"claude an empty pick is no pick", "claude", str("bypassPermissions"), nil, str(""), "bypassPermissions", "--permission-mode bypassPermissions", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			sid := fmt.Sprintf("00000000-0000-0000-0000-0000000e%04d", i+1)
			sn := naming.SessionName(c.agent, sid)
			require.NoError(t, term.CreateSession(ctx, sn, t.TempDir()))
			ls := &store.LiveSession{SessionID: sid, AgentType: c.agent, AgentName: c.name, WorkingDir: t.TempDir(), PermissionMode: c.stored}
			if c.flags != nil {
				ls.Flags = store.MarshalFlags(c.flags)
			}
			require.NoError(t, ss.RegisterLiveSession(ctx, ls))
			req := map[string]any{"session_id": sid, "agent_type": c.agent}
			if c.pick != nil {
				req["permission_mode"] = *c.pick
			}
			body, _ := json.Marshal(req)
			before := len(term.sentCommands())
			resp, err := http.Post(server.URL+"/api/sessions/live/"+sn+"/restart", "application/json", bytes.NewReader(body))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var res map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
			var cmd string
			require.Eventually(t, func() bool { // the restart types the new session's own launch line; other sessions of the run are not this one's
				for _, x := range term.sentCommands()[before:] {
					if strings.Contains(x, res["session_name"].(string)) {
						cmd = x
						return true
					}
				}
				return false
			}, 5*time.Second, 25*time.Millisecond, "the restart typed the new session's launch line")
			if c.has != "" {
				assert.Contains(t, cmd, c.has)
			}
			if c.lacks != "" {
				assert.NotContains(t, cmd, c.lacks)
			}
			nl, err := ss.GetLiveSession(ctx, res["session_id"].(string))
			require.NoError(t, err)
			require.NotNil(t, nl)
			require.NotNil(t, nl.PermissionMode)
			assert.Equal(t, c.wantMode, *nl.PermissionMode, "the mode it restarted in is the one the next restart knows")
		})
	}
}

// A mode that is not one is refused before anything is touched.
func TestARestartRefusesAPickedModeThatIsNotOne(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	sid := "00000000-0000-0000-0000-0000000e0f01"
	sn := naming.SessionName("claude", sid)
	require.NoError(t, term.CreateSession(ctx, sn, t.TempDir()))
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "x", WorkingDir: t.TempDir()}))
	body, _ := json.Marshal(map[string]any{"session_id": sid, "agent_type": "claude", "permission_mode": "yolo-please"})
	resp, err := http.Post(server.URL+"/api/sessions/live/"+sn+"/restart", "application/json", bytes.NewReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}
