package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// #19506: a restart (the Orchestrator's `coral-board restart` and the dashboard's Restart, one code path) brings the agent back on the model it is running now, after a model-chip switch, not the launch
// one, and with its custom role prompt, again after a second restart.

const keptPrompt = "You are the careful reviewer: never approve without running the tests."

// startedWith is what the restarted agent was started with: its start command and the prompt file the command reads.
func startedWith(t *testing.T, term *mockSessionTerminal, session string) (cmd, prompt string) {
	t.Helper()
	term.mu.Lock()
	defer term.mu.Unlock()
	for k, sent := range term.sent {
		if !strings.HasPrefix(k, session) {
			continue
		}
		for _, c := range sent {
			if m := regexp.MustCompile(`'(/[^']*coral_prompt_[^']*)'`).FindStringSubmatch(c); m != nil {
				b, err := os.ReadFile(m[1])
				require.NoError(t, err)
				return c, string(b)
			}
			if strings.Contains(c, "--session-id") { // an agent with no prompt has no prompt file
				return c, ""
			}
		}
	}
	t.Fatalf("no start command was typed for %s: %v", session, term.sent)
	return "", ""
}

func chipSwitched(t *testing.T, ss *store.SessionStore, id string) {
	t.Helper()
	ctx := context.Background()
	require.NoError(t, ss.SetSessionFlags(ctx, id, []string{"--model", "claude-opus-4-1"})) // the launch
	require.NoError(t, ss.UpdateContextWindow(ctx, id, 200000, "claude-opus-4-1"))
	_, err := ss.SetPrompt(ctx, id, ptr.NonEmpty(keptPrompt))
	require.NoError(t, err)
	require.NoError(t, ss.UpdateContextWindow(ctx, id, 200000, "claude-sonnet-4-5")) // the model chip, once confirmed, stores the model now in use
}

func TestTheOrchestratorsRestartKeepsTheModelNowInUseAndTheRolePrompt(t *testing.T) {
	r := newOrchRig(t)
	r.usualBoard()
	code, _ := r.operatorGrant("Orchestrator", nil)
	require.Equal(t, http.StatusOK, code)
	chipSwitched(t, r.ss, r.sid["Dev2"])
	for round := 1; round <= 2; round++ { // and the next restart too: the new row carries both on
		code, out := r.agentPost("Orchestrator", "restart", "Dev2", "")
		require.Equal(t, http.StatusOK, code, "round %d: %v", round, out)
		sub, err := r.h.bs.GetProjectSubscription(context.Background(), orchBoard, "Dev2")
		require.NoError(t, err)
		cmd, prompt := startedWith(t, r.term, sub.SessionName)
		assert.Contains(t, cmd, "--model claude-sonnet-4-5", "round %d: the model now in use, not the launch one", round)
		assert.NotContains(t, cmd, "claude-opus-4-1", "round %d", round)
		assert.True(t, strings.HasPrefix(prompt, keptPrompt), "round %d: the custom role prompt comes first (%q)", round, prompt[:min(len(prompt), 80)])
		id := strings.TrimPrefix(sub.SessionName, "claude-")
		ls, err := r.ss.GetLiveSession(context.Background(), id)
		require.NoError(t, err)
		require.NotNil(t, ls)
		assert.Equal(t, "claude-sonnet-4-5", ptr.Value(ls.Model), "round %d: stored on the new row", round)
		assert.True(t, strings.HasPrefix(ptr.Value(ls.Prompt), keptPrompt), "round %d", round)
		r.sid["Dev2"] = id
	}
}

func TestTheDashboardsRestartKeepsTheModelNowInUseAndTheRolePrompt(t *testing.T) {
	server, _, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "19506000-eeee-4000-8000-000000000001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "Dev", WorkingDir: t.TempDir()}))
	term.addSession("claude-"+id, t.TempDir())
	chipSwitched(t, ss, id)
	resp, err := http.Post(server.URL+"/api/sessions/live/claude-"+id+"/restart", "application/json", bytes.NewBufferString(`{"session_id":"`+id+`","agent_type":"claude"}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out struct {
		SessionName string `json:"session_name"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	cmd, prompt := startedWith(t, term, out.SessionName)
	assert.Contains(t, cmd, "--model claude-sonnet-4-5")
	assert.NotContains(t, cmd, "claude-opus-4-1")
	assert.True(t, strings.HasPrefix(prompt, keptPrompt), prompt[:min(len(prompt), 80)])
}

// #19506: a model change that never reached the store (a chip switch still unconfirmed, or /model typed in the terminal) is still the model the agent runs: the transcript says so, and a restart with no model in
// the request starts it on that one when it is a valid value of the agent's provider; anything else falls back to the stored model.
func TestARestartStartsOnTheModelTheTranscriptSaysTheAgentRunsNow(t *testing.T) {
	for _, c := range []struct{ name, stored, live, want string }{
		{"a model switched where the store never heard of it", "claude-opus-4-1", "claude-sonnet-4-5", "claude-sonnet-4-5"},
		{"an agent on the CLI's own default that runs a named model", "", "claude-sonnet-4-5", "claude-sonnet-4-5"},
		{"an invalid value falls back to the stored model", "claude-opus-4-1", "<synthetic>", "claude-opus-4-1"},
		{"a value with a space falls back", "claude-opus-4-1", "claude sonnet", "claude-opus-4-1"},
		{"a flag-shaped value never reaches the command line", "claude-opus-4-1", "--dangerously-skip-permissions", "claude-opus-4-1"},
		{"a single-dash flag falls back", "claude-opus-4-1", "-p", "claude-opus-4-1"},
		{"a semicolon falls back", "claude-opus-4-1", "claude-sonnet-4-5;rm", "claude-opus-4-1"},
		{"a value with a space and a flag falls back", "claude-opus-4-1", "claude-sonnet-4-5 --dangerously-skip-permissions", "claude-opus-4-1"},
		{"another provider's model is not the agent's", "claude-opus-4-1", "gpt-5", "claude-opus-4-1"},
		{"the dated id of the same family is the same model: the stored word stays", "claude-opus-4-1", "claude-opus-4-1-20250805", "claude-opus-4-1"},
		{"an alias of the same family stays", "opus", "claude-opus-4-1-20250805", "opus"},
		{"no transcript model: the stored one", "claude-opus-4-1", "", "claude-opus-4-1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("CLAUDE_PROJECTS_DIR", dir)
			server, h, term, ss := setupSessionsTestServer(t)
			ctx := context.Background()
			const id = "19506000-eeee-4000-8000-000000000002"
			ls := &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "Dev", WorkingDir: t.TempDir(), Model: ptr.NonEmpty(c.stored)}
			if c.stored != "" {
				ls.Flags = store.MarshalFlags([]string{"--model", c.stored})
			}
			require.NoError(t, ss.RegisterLiveSession(ctx, ls))
			term.addSession("claude-"+id, t.TempDir())
			if c.live != "" {
				path := filepath.Join(dir, "x", id+".jsonl")
				require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o700))
				line, _ := json.Marshal(map[string]any{"sessionId": id, "type": "assistant", "message": map[string]any{"model": c.live, "content": []any{}}, "timestamp": "2026-10-16T00:00:00Z"})
				require.NoError(t, os.WriteFile(path, append(line, '\n'), 0o600))
				h.jsonl.ReadClaudeTurnEvent(id, "")
			}
			resp, err := http.Post(server.URL+"/api/sessions/live/claude-"+id+"/restart", "application/json", bytes.NewBufferString(`{"session_id":"`+id+`","agent_type":"claude"}`))
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode)
			var out struct {
				SessionID   string `json:"session_id"`
				SessionName string `json:"session_name"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
			cmd, _ := startedWith(t, term, out.SessionName)
			if c.want == "" {
				assert.NotContains(t, cmd, "--model")
			} else {
				assert.Contains(t, cmd, "--model "+c.want+" ")
			}
			row, err := ss.GetLiveSession(ctx, out.SessionID)
			require.NoError(t, err)
			assert.Equal(t, c.want, ptr.Value(row.Model), "the new row keeps it for the next restart")
		})
	}
}
