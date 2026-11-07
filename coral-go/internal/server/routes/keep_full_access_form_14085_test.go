package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// The form's "Use Full access for this agent" (#14085, part d): a launch with keep_full_access starts the agent with Full access whatever its capabilities say, stores the choice for the new session
// and logs it; only the Operator can ask (an agent's token is refused and nothing is started); a terminal has no such setting.
func TestALaunchWithTheFormsChoiceStartsFullAccessAndStoresIt(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	stubCLIPaths(t, ss)
	ctx := context.Background()
	logs := captureSlog(t)
	dir := t.TempDir()
	writer := map[string]any{"allow": []string{"file_read", "file_write", "shell:coral-board *"}}
	launch := func(agentType string, keep bool, req func(*http.Request) *http.Request) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"agent_type": agentType, "working_dir": dir, "capabilities": writer, "flags": []string{"--dangerously-skip-permissions"}, "keep_full_access": keep, "backend": "tmux"})
		rec := httptest.NewRecorder()
		h.Launch(rec, req(httptest.NewRequest(http.MethodPost, "/api/sessions/launch", bytes.NewReader(b))))
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}
	same := func(r *http.Request) *http.Request { return r }

	// without the choice the writer's list narrows agy's Bypass (the report)
	before := len(term.sentCommands())
	rec, _ := launch("agy", false, same)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, strings.Join(term.sentCommands()[before:], "\n"), "--mode accept-edits")

	// with it: Full access, stored, logged
	for agentType, want := range map[string]string{"agy": "--dangerously-skip-permissions", "codex": "--dangerously-bypass-approvals-and-sandbox"} {
		before = len(term.sentCommands())
		rec, out := launch(agentType, true, same)
		require.Equal(t, http.StatusOK, rec.Code, agentType+": "+rec.Body.String())
		cmd := strings.Join(term.sentCommands()[before:], "\n")
		require.Contains(t, cmd, want, agentType)
		require.NotContains(t, cmd, "--mode accept-edits", agentType)
		sid, _ := out["session_id"].(string)
		require.NotEmpty(t, sid)
		on, err := ss.KeepFullAccess(ctx, sid)
		require.NoError(t, err)
		require.True(t, on, agentType+": the choice is stored for the new session")
	}
	require.Contains(t, logs(), "[keep-full-access] set")
	require.Contains(t, logs(), "via=launch")

	// an agent's token cannot ask, and nothing is started
	const parent = "11111111-2222-4333-8444-555555555555"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: parent, AgentType: "claude", AgentName: "parent", WorkingDir: dir}))
	asAgent := func(r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), verifiedSessionKey{}, &store.SessionTokenOwner{SessionID: parent, SessionName: "claude-" + parent}))
	}
	before = len(term.sentCommands())
	rec, _ = launch("agy", true, asAgent)
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), "Only the Operator")
	require.Len(t, term.sentCommands(), before, "nothing was started")

	// a plain terminal has no such setting
	rec, _ = launch("terminal", true, same)
	require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
}

// A restart with the form's choice starts Full access whatever the capabilities say, stores it on the NEW session (also when the same request edited the capabilities, which ends an earlier choice),
// and is refused to anyone but the Operator.
func TestARestartWithTheFormsChoiceIsFullAccessAndTheChoiceIsStoredOnTheNewSession(t *testing.T) {
	rig := setupAgyTestRig(t)
	ctx := context.Background()
	sid := "33333333-4444-4555-8666-777777777777"
	name := naming.SessionName(at.Agy, sid)
	writer := `{"allow":["file_read","file_write","shell:coral-board *"]}`
	mode := "bypassPermissions"
	require.NoError(t, rig.term.CreateSession(ctx, name, rig.workdir))
	require.NoError(t, rig.ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: at.Agy, AgentName: "tw", WorkingDir: rig.workdir, Capabilities: &writer, PermissionMode: &mode, Flags: store.MarshalFlags([]string{"--dangerously-skip-permissions"})}))
	restart := func(session string, body map[string]any) (*httptest.ResponseRecorder, string) {
		body["agent_type"], body["session_id"] = at.Agy, session
		b, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		rig.router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/live/"+naming.SessionName(at.Agy, session)+"/restart", bytes.NewReader(b)))
		return rec, lastSentCommand(rig.term)
	}
	rec, cmd := restart(sid, map[string]any{})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, cmd, "--mode accept-edits", "without the choice the list narrows the Bypass (the report)")
	require.NotContains(t, cmd, "--dangerously-skip-permissions")

	live, err := rig.ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	var cur string
	for _, s := range live {
		if s.AgentName == "tw" || s.ResumeFromID != nil && *s.ResumeFromID == sid {
			cur = s.SessionID
		}
	}
	require.NotEmpty(t, cur)
	// the form's choice, together with an edit of the capabilities in the same request
	rec, cmd = restart(cur, map[string]any{"keep_full_access": true, "capabilities": map[string]any{"allow": []string{"file_read"}}})
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, cmd, "--dangerously-skip-permissions")
	require.NotContains(t, cmd, "--mode")
	live, err = rig.ss.GetAllLiveSessions(ctx)
	require.NoError(t, err)
	stored := 0
	for _, s := range live {
		if on, _ := rig.ss.KeepFullAccess(ctx, s.SessionID); on {
			stored++
			require.NotEqual(t, cur, s.SessionID, "on the new session, not the replaced one")
		}
	}
	require.Equal(t, 1, stored, "exactly one session has the choice")
}
