package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/store"
)

// #15719: the dialog's line is the launch builders' answer for the chosen permissions.
func TestLaunchPermissionArgsRouteAnswersFromTheLaunchBuilders(t *testing.T) {
	h := &SessionsHandler{}
	ask := func(body string) (int, string) {
		w := httptest.NewRecorder()
		h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", strings.NewReader(body)))
		var m map[string]any
		if json.Unmarshal(w.Body.Bytes(), &m) == nil && m["command"] != nil {
			delete(m, "command") // the start command has its own test (#15951); here the permission arguments are the question
			b, _ := json.Marshal(m)
			return w.Code, string(b)
		}
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
	assert.Contains(t, note, "without asking you")
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

// #15951: the start command the dialogs show is the one the launch sends, for each agent type and for a custom permission mode, with the session's own values as placeholders.
func TestLaunchPermissionArgsRouteShowsTheCommandTheLaunchSends(t *testing.T) {
	rig := newCustomLaunchRig(t)
	preview := func(body map[string]any) string {
		b, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		rig.h.PostLaunchPermissionArgs(w, httptest.NewRequest(http.MethodPost, "/api/launch/permission-args", bytes.NewReader(b)))
		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		var got struct{ Command string }
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
		return got.Command
	}
	rig.save(t, store.CustomMode{ID: "aaaaaaaaaaaaaaaa", AgentType: at.Claude, Name: "mine", Flags: []string{"--permission-mode", "plan"}},
		store.CustomMode{ID: "bbbbbbbbbbbbbbbb", AgentType: at.Codex, Name: "mine too", Flags: []string{"-s", "workspace-write", "-a", "never"}})
	for _, c := range []struct{ typ, mode string }{{at.Claude, "default"}, {at.Claude, "plan"}, {at.Claude, "custom:aaaaaaaaaaaaaaaa"}, {at.Codex, "bypassPermissions"}, {at.Codex, "custom:bbbbbbbbbbbbbbbb"}, {at.Agy, "plan"}} {
		// the dashboard sends a built-in mode as the CLI's own flags and a custom one by name
		launchMode, flags := c.mode, []string(nil)
		if !strings.HasPrefix(c.mode, "custom:") {
			launchMode, flags = "default", agent.PermissionFlagsForAgent(c.typ, c.mode)
		}
		lb, _ := json.Marshal(map[string]any{"agent_type": c.typ, "working_dir": rig.workdir, "permission_mode": launchMode, "flags": flags})
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(lb)))
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		sent := lastSentCommand(rig.term)
		want := agent.RedactLaunchCommand(sent, out["session_id"].(string))
		got := preview(map[string]any{"agent_type": c.typ, "permission_mode": launchMode, "flags": flags})
		// a launch wraps the program in the CLI's own node and bundle path and adds Coral's own flags; the preview is that command's program and arguments
		assert.Equal(t, trimLaunchWrappers(want), trimLaunchWrappers(got), c.typ+" "+c.mode+": the preview is the launch's command")
		assert.NotContains(t, got, "custom:", "the id never shows")
		assert.NotContains(t, got, out["session_id"].(string))
	}
	// a thinking level is the CLI's one --effort, as the launch puts it
	assert.Contains(t, preview(map[string]any{"agent_type": at.Claude, "permission_mode": "default", "thinking": "high"}), "--effort high")
}

// trimLaunchWrappers drops what only a real launch adds in front of the program (the CLI's node, the bundle's PATH), so the two lines are compared from the program on.
func trimLaunchWrappers(cmd string) string {
	if i := strings.Index(cmd, "claude"); i > 0 && strings.Contains(cmd[:i], "fake-") {
		return cmd[i:]
	}
	return cmd
}
