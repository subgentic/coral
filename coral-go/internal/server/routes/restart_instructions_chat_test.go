package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #15283 (walk 13 M10): a restart starts the CLI with the agent's whole instructions as its first message. The transcript records it as a user turn, which the chat drew as the person's own "You" bubble: a wall of text.
// Coral gave it, so the turn is flagged a delivery and folds like any other.
func TestARestartsInstructionsTurnIsFlaggedAsCoralsOwn(t *testing.T) {
	server, handler, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "restart-instructions-15283"
	name := naming.SessionName("claude", id)
	term.addSession(name, t.TempDir())
	prompt := "You are the UI worker on this team. " + strings.Repeat("Keep every screen accessible and keyboard first. ", 12)
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{
		SessionID: id, AgentType: "claude", AgentName: "coral-go", DisplayName: ptr.NonEmpty("UI"), Prompt: ptr.NonEmpty(prompt), BoardName: ptr.NonEmpty("restart-instructions-board"),
	}))
	_, err := handler.bs.Subscribe(ctx, "restart-instructions-board", "UI", "UI", name, nil, "all")
	require.NoError(t, err)

	resp, err := http.Post(server.URL+"/api/sessions/live/"+name+"/restart", "application/json", bytes.NewBufferString(`{"session_id":"`+id+`","agent_type":"claude"}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var result struct {
		SessionID   string `json:"session_id"`
		SessionName string `json:"session_name"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&result))

	first := agent.BuildBoardActionPrompt(handler.boardLabel("restart-instructions-board"), naming.SubscriberID("UI", "claude"), prompt, nil, "")
	require.NotEmpty(t, first)
	require.True(t, ptymanager.HasDeliveredTexts(result.SessionName), "the restart recorded what it started the CLI with")
	msgs := []map[string]any{
		{"type": "user", "content": first, "timestamp": time.Now().UTC().Format(time.RFC3339Nano)},
		{"type": "user", "content": "please carry on with the batch, thanks a lot", "timestamp": time.Now().UTC().Format(time.RFC3339Nano)},
	}
	out := markCoralDeliveries(msgs, "claude", result.SessionID, result.SessionName)
	assert.Equal(t, true, out[0]["coral_notice"], "the instructions are Coral's turn")
	assert.Nil(t, out[1]["coral_notice"], "the person's own turn is left as it is")
}

// A wake or resume starts the CLI with the instructions again: flagged too. A first launch is not: the prompt a person wrote in the launch dialog is their own first message.
func TestAWakesInstructionsAreFlaggedButAFirstLaunchsAreNot(t *testing.T) {
	_, handler, _, _ := setupSessionsTestServer(t)
	run := func(id, resume string) string {
		p := agent.LaunchParams{SessionID: id, SessionName: naming.SessionName("claude", id), ResumeSessionID: resume, BoardName: "wake-board", Role: "UI", Prompt: "You are the UI worker. " + strings.Repeat("Keep every screen accessible. ", 8), CoralDir: t.TempDir()}
		_, err := handler.launchCommand(context.Background(), agent.GetAgent("claude"), p)
		require.NoError(t, err)
		return p.SessionName
	}
	assert.True(t, ptymanager.HasDeliveredTexts(run("wake-15283-a", "wake-15283-a")), "a resume's instructions are Coral's")
	assert.False(t, ptymanager.HasDeliveredTexts(run("launch-15283-b", "")), "a first launch's prompt is the person's")
}
