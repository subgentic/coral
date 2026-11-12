package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
)

// #15719: the dialog's line is the launch builders' answer for the chosen permissions.
func TestLaunchPermissionArgsRouteAnswersFromTheLaunchBuilders(t *testing.T) {
	h := &SessionsHandler{}
	ask := func(body string) (int, string) {
		w := httptest.NewRecorder()
		h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", strings.NewReader(body)))
		return w.Code, w.Body.String()
	}
	code, out := ask(`{"agent_type":"codex","permission_mode":"bypassPermissions"}`)
	require.Equal(t, http.StatusOK, code, out)
	assert.JSONEq(t, `{"args":["--dangerously-bypass-approvals-and-sandbox"],"text":"--dangerously-bypass-approvals-and-sandbox","note":""}`, out)
	_, out = ask(`{"agent_type":"codex","permission_mode":"plan"}`)
	assert.JSONEq(t, `{"args":["--sandbox","read-only","-a","on-request"],"text":"--sandbox read-only -a on-request","note":""}`, out)
	_, out = ask(`{"agent_type":"codex","permission_mode":"plan","keep_full_access":true}`)
	assert.Contains(t, out, `"--dangerously-bypass-approvals-and-sandbox"`)
	_, out = ask(`{"agent_type":"codex","permission_mode":"default"}`)
	assert.JSONEq(t, `{"args":[],"text":"","note":"No permission flags are added, so Codex's own settings (its config file) decide."}`, out)
	code, _ = ask(`not json`)
	assert.Equal(t, http.StatusBadRequest, code)
	// Security's #15726: the body and each flag are capped.
	code, _ = ask(`{"agent_type":"codex","flags":["` + strings.Repeat("x", 201) + `"]}`)
	assert.Equal(t, http.StatusBadRequest, code, "a flag over 200 bytes")
	code, _ = ask(`{"agent_type":"codex","pad":"` + strings.Repeat("x", 17<<10) + `"}`)
	assert.Equal(t, http.StatusBadRequest, code, "a body over 16 KB")
	code, _ = ask(`{"agent_type":"codex","flags":[` + strings.TrimSuffix(strings.Repeat(`"-a",`, 41), ",") + `]}`)
	assert.Equal(t, http.StatusBadRequest, code, "more than 40 flags")
}

// #15735: the reason beside the flags for the three cases QA #15727 found: a role's Shell rule narrows Bypass, Default plus Shell gets Auto's pair from the capabilities, and Default with nothing adds no flags.
func TestLaunchPermissionArgsRouteSaysWhyTheFlagsDifferFromThePick(t *testing.T) {
	h := &SessionsHandler{}
	note := func(body string) string {
		w := httptest.NewRecorder()
		h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", strings.NewReader(body)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var got struct {
			Note string `json:"note"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
		return got.Note
	}
	assert.Contains(t, note(`{"agent_type":"codex","permission_mode":"bypassPermissions","capabilities":{"allow":["shell"],"deny":["git_write"]}}`), "narrow this mode to workspace writes, asks first", "Bypass with a Shell rule")
	assert.Contains(t, note(`{"agent_type":"codex","permission_mode":"default","capabilities":{"allow":["shell"]}}`), "capabilities set them: workspace writes, never asks", "Default with Shell, no limits")
	assert.Contains(t, note(`{"agent_type":"codex","permission_mode":"default"}`), "Codex's own settings", "Default with no flags")
	assert.Equal(t, "", note(`{"agent_type":"codex","permission_mode":"bypassPermissions"}`), "the pick's own flags run: no note")
	assert.Equal(t, "", note(`{"agent_type":"claude","permission_mode":"default"}`), "no note for another agent")
}

// #15780: the flags line for Auto is Codex's own auto-review on a Codex that has it, with the reason beside it; an older Codex shows today's pair and says why; a role's Shell rule that narrows Auto shows the narrowed
// pair and CodexModeNote's reason.
func TestLaunchPermissionArgsRouteShowsCodexAutoReview(t *testing.T) {
	old := agent.CodexVersionProbe
	t.Cleanup(func() { agent.CodexVersionProbe = old })
	h := &SessionsHandler{}
	ask := func(version, body string) (string, string) {
		agent.CodexVersionProbe = func(string) string { return version }
		w := httptest.NewRecorder()
		h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", strings.NewReader(body)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var got struct {
			Text string `json:"text"`
			Note string `json:"note"`
		}
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
		return got.Text, got.Note
	}
	const netOn = "-c sandbox_workspace_write.network_access=true " // Auto keeps the network on for Coral's own calls, either way
	text, note := ask("0.163.0", `{"agent_type":"codex","permission_mode":"auto"}`)
	assert.Equal(t, netOn+"--approve-for-me", text)
	assert.Contains(t, note, "auto-review")
	assert.Contains(t, note, "Shell rule")
	text, note = ask("0.163.0", `{"agent_type":"codex","flags":["--sandbox","workspace-write","-a","never"]}`)
	assert.Equal(t, netOn+"--approve-for-me", text, "the flags the dashboard sends for Auto")
	assert.Contains(t, note, "auto-review")
	text, note = ask("0.162.0", `{"agent_type":"codex","permission_mode":"auto"}`)
	assert.Equal(t, netOn+"--sandbox workspace-write -a never", text)
	assert.Contains(t, note, "older than 0.163.0")
	text, note = ask("0.163.0", `{"agent_type":"codex","permission_mode":"auto","capabilities":{"allow":["shell"],"deny":["git_write"]}}`)
	assert.Equal(t, "--sandbox workspace-write -a on-request", text, "a Shell rule narrows Auto")
	assert.Contains(t, note, "narrow this mode")
	text, note = ask("0.163.0", `{"agent_type":"codex","permission_mode":"plan"}`)
	assert.Equal(t, "--sandbox read-only -a on-request", text)
	assert.Equal(t, "", note)
}
