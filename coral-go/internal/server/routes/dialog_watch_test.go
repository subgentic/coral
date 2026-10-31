package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11437: an agent at a dialog is known from its screen, even with no board message waiting: the same prompt on two passes in a row is at_dialog {since, after_min, notify} on the live row, and it is gone
// the pass after the screen shows it no more, or at once when an answer is sent.

var ansiSGR = regexp.MustCompile("\x1b\\[[0-9;]*m")

// claudeTrustScreen is the captured Claude folder-trust screen (the corpus the gate reads), as the pane's text.
func claudeTrustScreen(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("../../ptymanager/testdata/screens/claude/2.1.300/trust.ansi")
	require.NoError(t, err)
	return ansiSGR.ReplaceAllString(string(b), "")
}

func atDialogOf(t *testing.T, base, sid string) any {
	t.Helper()
	resp, err := http.Get(base + "/api/sessions/live")
	require.NoError(t, err)
	defer resp.Body.Close()
	var raw json.RawMessage
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&raw))
	var rows []map[string]any
	if json.Unmarshal(raw, &rows) != nil {
		var wrapped struct {
			Sessions []map[string]any `json:"sessions"`
		}
		require.NoError(t, json.Unmarshal(raw, &wrapped))
		rows = wrapped.Sessions
	}
	for _, r := range rows {
		if r["session_id"] == sid {
			v, has := r["at_dialog"]
			require.True(t, has, "the row has the at_dialog key")
			return v
		}
	}
	t.Fatalf("no row for %s", sid)
	return nil
}

func TestAnAgentAtTheTrustScreenIsAtADialogWithNoMessageWaiting(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-00000000d1a1"
	require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-" + sid, WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-"+sid, "/tmp/test")
	terminal.outputs["claude-"+sid] = claudeTrustScreen(t)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC)

	h.dialogPass(ctx, t0)
	assert.Nil(t, atDialogOf(t, server.URL, sid), "one pass is not yet a dialog: a menu on screen for a moment is not one")
	h.dialogPass(ctx, t0.Add(15*time.Second))
	got, ok := atDialogOf(t, server.URL, sid).(map[string]any)
	require.True(t, ok, "the same prompt on two passes: at a dialog")
	assert.Equal(t, t0.Format(time.RFC3339), got["since"], "since is when it was first seen")
	assert.EqualValues(t, atDialogMinutes, got["after_min"], "the default, for an agent on no board")
	assert.Equal(t, true, got["notify"])
	assert.NotContains(t, got, "question", "no text of the prompt is served")
	assert.NotContains(t, got, "options")

	h.dialogPass(ctx, t0.Add(30*time.Second))
	got, _ = atDialogOf(t, server.URL, sid).(map[string]any)
	assert.Equal(t, t0.Format(time.RFC3339), got["since"], "still the same dialog: since does not move")

	terminal.mu.Lock()
	terminal.outputs["claude-"+sid] = screenIdleList
	terminal.mu.Unlock()
	h.dialogPass(ctx, t0.Add(45*time.Second))
	assert.Nil(t, atDialogOf(t, server.URL, sid), "the pass after the screen shows the prompt gone, it is gone")
}

func TestADifferentPromptRestartsTheCountAndAnAgentThatSleepsLeavesNothing(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-00000000d1a2"
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-" + sid, WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-"+sid, "/tmp/test")
	t0 := time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC)
	terminal.outputs["claude-"+sid] = claudeTrustScreen(t)
	h.dialogPass(ctx, t0)
	h.dialogPass(ctx, t0.Add(15*time.Second))
	require.NotNil(t, atDialogOf(t, server.URL, sid))
	terminal.mu.Lock()
	terminal.outputs["claude-"+sid] = screenPermission // another prompt
	terminal.mu.Unlock()
	h.dialogPass(ctx, t0.Add(30*time.Second))
	assert.Nil(t, atDialogOf(t, server.URL, sid), "a different prompt starts counting again: one pass is not yet a dialog")
	h.dialogPass(ctx, t0.Add(45*time.Second))
	got, _ := atDialogOf(t, server.URL, sid).(map[string]any)
	require.NotNil(t, got)
	assert.Equal(t, t0.Add(30*time.Second).Format(time.RFC3339), got["since"], "since is when THIS prompt was first seen")

	require.NoError(t, ss.SetSessionSleeping(ctx, sid, true))
	h.dialogPass(ctx, t0.Add(60*time.Second))
	assert.Nil(t, h.dialogs.field(sid), "a sleeping agent has no screen: nothing is kept")
	h.dialogs.mu.Lock()
	_, kept := h.dialogs.seen[sid]
	h.dialogs.mu.Unlock()
	assert.False(t, kept, "not even a half-counted prompt")
}

func TestAnAnswerSentClearsTheDialogAtOnce(t *testing.T) {
	server, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-00000000d1a3"
	ctx := context.Background()
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-" + sid, WorkingDir: "/tmp/test"}))
	terminal.addSession("claude-"+sid, "/tmp/test")
	promptTextDelay = 0
	fastPromptChecks(t)
	terminal.outputs["claude-"+sid] = screenPermission
	terminal.onRaw = func(string) {
		terminal.mu.Lock()
		terminal.outputs["claude-"+sid] = screenIdleList
		terminal.mu.Unlock()
	}
	t0 := time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC)
	h.dialogPass(ctx, t0)
	h.dialogPass(ctx, t0.Add(15*time.Second))
	require.NotNil(t, atDialogOf(t, server.URL, sid), "at the permission menu")

	b, _ := json.Marshal(map[string]any{"n": 1, "label": "Yes", "session_id": sid, "agent_type": "claude"})
	resp, err := http.Post(server.URL+"/api/sessions/live/claude-"+sid+"/answer-prompt", "application/json", bytes.NewReader(b))
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Nil(t, atDialogOf(t, server.URL, sid), "answered: not a dialog, with no wait for the next pass")
}

func TestTheDialogMinutesAreTheTeamsHeldNoticeSetting(t *testing.T) {
	_, h, terminal, ss := setupSessionsTestServer(t)
	const sid = "00000000-0000-0000-0000-00000000d1a4"
	ctx := context.Background()
	board := "dlg-team"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: sid, AgentType: "claude", AgentName: "claude-" + sid, WorkingDir: "/tmp/test", BoardName: &board}))
	terminal.addSession("claude-"+sid, "/tmp/test")
	terminal.outputs["claude-"+sid] = claudeTrustScreen(t)
	hs := h.bs.GetHealthSettings(ctx, board)
	hs.HeldNotice.AfterMin, hs.HeldNotice.On = 25, false
	require.NoError(t, h.bs.SetHealthSettings(ctx, board, hs))
	t0 := time.Date(2026, 10, 31, 6, 0, 0, 0, time.UTC)
	h.dialogPass(ctx, t0)
	h.dialogPass(ctx, t0.Add(15*time.Second))
	got, ok := h.dialogs.field(sid).(map[string]any)
	require.True(t, ok)
	assert.EqualValues(t, 25, got["after_min"], "the team's held_notice.after_min")
	assert.Equal(t, false, got["notify"], "and its on switch: a team that turned the notice off is not sent a Needs you item")
}

// #11437 (d): the captured Claude folder-trust screen is read as a prompt by the parser the watcher uses, with its choices; no board message and no hook is needed for that.
func TestTheCapturedClaudeTrustScreenIsAPrompt(t *testing.T) {
	s, ok := parsePromptScreen(claudeTrustScreen(t))
	require.True(t, ok, "the trust screen is a prompt")
	assert.NotEmpty(t, s.Question)
	require.GreaterOrEqual(t, len(s.Options), 2, "its choices")
	var labels []string
	for _, o := range s.Options {
		labels = append(labels, o.Label)
	}
	assert.Contains(t, s.Question+" "+labels[0], "trust", "it is the trust question: %q %v", s.Question, labels)
}
