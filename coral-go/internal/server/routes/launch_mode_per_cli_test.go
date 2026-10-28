package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #10466 (Security Reviewer Windows, on #10381): a Codex launch must never record a mode Codex lacks. A saved default of Accept edits made a Codex launch record acceptEdits (Codex's Accept edits flags
// are its Default ones): the recorded mode is what a restart, a wake and a resurrect restore and what the chat says. Through POST /api/sessions/launch, for each CLI and each saved default: the mode that is
// recorded AND the permission flags the launch command carries. Only Codex's Accept edits changes (it is recorded as Default, its command unchanged); every other row is what it launched with before.
func TestALaunchRecordsOnlyAModeItsCLIHas(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	defer server.Close()
	stubCLIPaths(t, ss)
	ctx := context.Background()
	launch := func(agentType string, body map[string]any) (recorded, command string) {
		t.Helper()
		body["agent_type"] = agentType
		body["working_dir"] = t.TempDir()
		b, _ := json.Marshal(body)
		resp, err := http.Post(server.URL+"/api/sessions/launch", "application/json", bytes.NewReader(b))
		require.NoError(t, err)
		defer resp.Body.Close()
		var res map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&res))
		require.Equal(t, http.StatusOK, resp.StatusCode, "%v", res)
		sid := res["session_id"].(string)
		ls, err := ss.GetLiveSession(ctx, sid)
		require.NoError(t, err)
		require.NotNil(t, ls)
		require.NotNil(t, ls.PermissionMode, "a mode is recorded")
		term.mu.Lock()
		defer term.mu.Unlock()
		for name, cmds := range term.sent {
			if strings.Contains(name, sid) && len(cmds) > 0 {
				command = cmds[len(cmds)-1]
			}
		}
		require.NotEmpty(t, command, "the launch command")
		return *ls.PermissionMode, command
	}
	type row struct{ recorded, flags string }
	modes := []string{"default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"}
	// CLI -> saved default -> what is recorded and the permission flags the launch command carries today (read from the launch, not assumed)
	want := map[string]map[string]row{
		at.Claude: {
			"default": {"default", "--permission-mode default"}, "plan": {"plan", "--permission-mode plan"}, "acceptEdits": {"acceptEdits", "--permission-mode acceptEdits"},
			"auto": {"auto", "--permission-mode auto"}, "bypassPermissions": {"bypassPermissions", "--permission-mode bypassPermissions"}, "dontAsk": {"dontAsk", "--permission-mode dontAsk"},
		},
		at.Codex: {
			"default": {"default", ""}, "plan": {"plan", "--sandbox read-only -a on-request"},
			"acceptEdits": {"default", ""}, // the mode Codex lacks is recorded as Default, and its command is Default's
			"auto":        {"auto", "-c sandbox_workspace_write.network_access=true --sandbox workspace-write -a never"}, "bypassPermissions": {"bypassPermissions", "--dangerously-bypass-approvals-and-sandbox"},
			"dontAsk": {"dontAsk", "-c sandbox_workspace_write.network_access=true --sandbox workspace-write -a never"},
		},
		at.Agy: { // Antigravity is unchanged: what its launch records and runs with today (its Auto launches with the bypass flag and its Don't ask as Plan; not this task's to change)
			"default": {"default", ""}, "plan": {"plan", "--mode plan"}, "acceptEdits": {"acceptEdits", "--mode accept-edits"},
			"auto": {"auto", "--dangerously-skip-permissions"}, "bypassPermissions": {"bypassPermissions", "--dangerously-skip-permissions"}, "dontAsk": {"dontAsk", "--mode plan"},
		},
	}
	for cli, byMode := range want {
		for _, saved := range modes {
			require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", saved))
			recorded, command := launch(cli, map[string]any{})
			assert.Equal(t, byMode[saved].recorded, recorded, "%s with %s saved: recorded", cli, saved)
			assert.Equal(t, byMode[saved].flags, permissionFlagsOf(command), "%s with %s saved: the command's permission flags", cli, saved)
		}
	}
	// the raw flags that read as Accept edits to Codex are Default's too
	require.NoError(t, ss.SetSetting(ctx, "default_permission_mode", "auto"))
	recorded, command := launch(at.Codex, map[string]any{"flags": []string{"--sandbox", "workspace-write", "-a", "on-request"}})
	assert.NotEqual(t, "acceptEdits", recorded, "Codex's own Accept edits flags record the mode Codex has")
	assert.Equal(t, "--sandbox workspace-write -a on-request", permissionFlagsOf(command), "and the flags typed are the ones it ran with")
	// an explicit Default stays Default for every CLI
	for cli := range want {
		recorded, _ := launch(cli, map[string]any{"permission_mode": "default"})
		assert.Equal(t, "default", recorded, cli)
	}
}

var permissionFlagsRe = regexp.MustCompile(`--permission-mode \S+|--sandbox \S+ -a \S+|--dangerously-bypass-approvals-and-sandbox|--dangerously-skip-permissions|--mode \S+|-c sandbox_workspace_write\.network_access=true`)

// permissionFlagsOf is the permission flags of a launch command, in the order they appear.
func permissionFlagsOf(command string) string {
	return strings.Join(permissionFlagsRe.FindAllString(command, -1), " ")
}
