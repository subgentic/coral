package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #14345 (the Operator's bug #14340): a mock Claude agent asks a question, the person answers it IN THE TERMINAL, and the agent goes on. Claude reports no PostToolUse for the question in time (the
// reproduction: it never arrives, or arrives minutes later with a long command), so the live row, Needs you and the held-message gate kept saying "waiting" while the transcript showed the agent working.
// Only the agent's own evidence clears the wait (#14203): an assistant entry in its transcript written after the question was raised.
func TestAQuestionSettledInTheTerminalClearsFromTheRowAndTheGate(t *testing.T) {
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	server, h, terminal, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "dddddddd-1434-4a00-8000-000000000001"
	name := "claude-" + sid
	terminal.addSession(name, "/work")
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "asker", WorkingDir: "/work", CreatedAt: time.Now().UTC().Format(time.RFC3339)}))
	require.NoError(t, ss.SetCLIVersion(ctx, sid, "2.1.300"))
	tok := agentToken(t, h, sid, name)
	post := func(body string) {
		t.Helper()
		body = strings.Replace(body, "{", `{"hooks_rev":`+strconv.Itoa(agent.ClaudeHooksRev)+`,`, 1)
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/asker/events", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, body)
	}
	row := func() map[string]any {
		t.Helper()
		resp, err := http.Get(server.URL + "/api/sessions/live")
		require.NoError(t, err)
		defer resp.Body.Close()
		var rows []map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&rows))
		for _, r := range rows {
			if r["session_id"] == sid {
				return r
			}
		}
		t.Fatalf("no live row for %s", sid)
		return nil
	}
	gate := func() ptymanager.AgentState {
		st, _ := h.gateState(ctx, name, "claude", sid)
		return st
	}
	dir := filepath.Join(projects, "-work")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	transcript := filepath.Join(dir, sid+".jsonl")
	at := func(d time.Duration) string { return time.Now().Add(d).UTC().Format(time.RFC3339Nano) }
	require.NoError(t, os.WriteFile(transcript, []byte(`{"type":"user","message":{"role":"user","content":"Pick a colour"},"timestamp":"`+at(-time.Minute)+`"}`+"\n"), 0o600))
	appendLine := func(line string) {
		t.Helper()
		f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
		require.NoError(t, err)
		_, err = f.WriteString(line + "\n")
		require.NoError(t, err)
		require.NoError(t, f.Close())
	}
	assistant := func(when time.Duration, tool string) string { // an assistant entry, as Claude writes it: a model, a tool call
		return `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"tool_use","id":"toolu_` + tool + `","name":"` + tool + `","input":{}}]},"timestamp":"` + at(when) + `"}`
	}

	post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	post(`{"event_type":"permission_request","summary":"Waiting for the user: question (AskUserQuestion)","tool_name":"AskUserQuestion","detail_json":{"kind":"question","tool_name":"AskUserQuestion"}}`)
	// The entry that carries the question's own tool call is older than the request or within its own moment: it never answers it.
	appendLine(assistant(-time.Second, "AskUserQuestion"))
	appendLine(assistant(time.Second, "AskUserQuestion"))
	r := row()
	assert.Equal(t, true, r["waiting_for_input"], "the question is open: the transcript holds only its own entry")
	assert.Equal(t, "question", r["waiting_kind"])
	assert.Equal(t, ptymanager.StateBlocked, gate().State, "the held-message gate sees a blocked agent")

	// The person answered in the terminal and the agent went on: its next tool call is an assistant entry written well after the question.
	appendLine(assistant(10*time.Second, "Read"))
	r = row()
	assert.NotEqual(t, true, r["waiting_for_input"], "an assistant entry after the question: the row is no longer waiting")
	assert.Empty(t, r["waiting_kind"])
	assert.NotEqual(t, ptymanager.StateBlocked, gate().State, "and the gate no longer holds the agent as blocked")
	st := h.deriveSingleSessionState(ctx, sid, 0)
	assert.False(t, st.NeedsInput)
	assert.True(t, st.InTurn, "the agent is in its turn")
}

// Only the agent's own question is closed this way: a permission prompt stays whatever the agent has written, and a question stays when nothing was written after it.
func TestAPermissionPromptStaysOpenWhateverTheTranscriptHolds(t *testing.T) {
	projects := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", projects)
	server, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	sid := "dddddddd-1434-4a00-8000-000000000002"
	name := "claude-" + sid
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "asker2", WorkingDir: "/work"}))
	require.NoError(t, ss.SetCLIVersion(ctx, sid, "2.1.300"))
	tok := agentToken(t, h, sid, name)
	post := func(body string) {
		t.Helper()
		body = strings.Replace(body, "{", `{"hooks_rev":`+strconv.Itoa(agent.ClaudeHooksRev)+`,`, 1)
		req, _ := http.NewRequest("POST", server.URL+"/api/sessions/live/asker2/events", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(store.SessionTokenHeader, tok)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusOK, resp.StatusCode, body)
	}
	dir := filepath.Join(projects, "-work")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	later := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	line := `{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"tool_use","id":"toolu_r","name":"Read","input":{}}]},"timestamp":"` + later + `"}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, sid+".jsonl"), []byte(line), 0o600))

	post(`{"event_type":"prompt_submit","summary":"User submitted prompt"}`)
	post(`{"event_type":"permission_request","summary":"Waiting for the user: permission (Bash)","tool_name":"Bash","detail_json":{"kind":"permission","tool_name":"Bash"}}`)
	st := h.deriveSingleSessionState(ctx, sid, 0)
	assert.True(t, st.NeedsInput, "a permission prompt waits for the person whatever the transcript holds")
	assert.Equal(t, "permission", st.WaitingKind)
}
