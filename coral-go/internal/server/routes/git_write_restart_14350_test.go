package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14350 (Security's point 1): the capabilities' allow list is built at every launch from the stored capabilities and the mode the launch uses, so a Restart that moves an agent from Default to
// Auto writes a list without the git rules, and one back to Default writes them again.
func TestARestartFromDefaultToAutoDropsTheGitRules(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	const sid = "44444444-5555-4666-8777-888888888888"
	mode, caps := "default", `{"allow":["file_read","shell","git_write"]}`
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "coral-go", WorkingDir: t.TempDir(), PermissionMode: &mode, Capabilities: &caps}))
	name := "claude-" + sid
	term.addSession(name, t.TempDir())
	cur, curName := sid, name // a restart gives the agent a new session: the next one restarts that
	restart := func(body map[string]any) string {
		t.Helper()
		body["session_id"], body["agent_type"] = cur, "claude"
		rb, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		h.Restart(rec, dropAt2(httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+curName+"/restart", bytes.NewReader(rb)), map[string]string{"name": curName}))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var res struct {
			SessionID string `json:"session_id"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
		require.NotEmpty(t, res.SessionID, rec.Body.String())
		cur, curName = res.SessionID, "claude-"+res.SessionID
		term.addSession(curName, t.TempDir())
		cmds := term.sentCommands()
		cmd := cmds[len(cmds)-1]
		m := regexp.MustCompile(`--settings (\S+)`).FindStringSubmatch(cmd)
		require.NotNil(t, m, cmd)
		b, err := os.ReadFile(strings.Trim(m[1], `'"`))
		require.NoError(t, err)
		return cmd + "\n" + string(b)
	}
	out := restart(map[string]any{})
	assert.Contains(t, out, "--permission-mode default")
	assert.Contains(t, out, "Bash(git push *)", "Default keeps the rules")
	out = restart(map[string]any{"permission_mode": "auto"})
	assert.Contains(t, out, "--permission-mode auto")
	assert.NotContains(t, out, "Bash(git", "Auto leaves git to its own judgement")
	assert.Contains(t, out, `"Bash"`, "the blanket Bash allow stays")
	out = restart(map[string]any{"permission_mode": "default"})
	assert.Contains(t, out, "Bash(git push *)", "back in Default the rules are back")
}
