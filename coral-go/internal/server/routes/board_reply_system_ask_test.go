package routes

import (
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #21500: the Operator's reply to a question Coral made itself (the custom-check approval) always posts. The dashboard opens a reply with "@<asker> ", Coral's own sender is no member of the board, and the
// unknown-mention rule refused it ("no subscriber named Coral"). The reply now speaks to the team's Orchestrator, or carries no mention when there is none; plain words and a member's question are untouched.
func TestReplyToACoralMadeQuestionPostsAndSpeaksToTheOrchestrator(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Dev", "Developer", "claude-11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	ask := func(project, from string) int64 {
		t.Helper()
		msg, err := h.bs.PostSystemDefusedMessage(ctx, project, from, "@Operator [Coral] A custom check waits for your approval: prod-alerts.", nil)
		require.NoError(t, err)
		require.NoError(t, h.bs.RecordAsk(ctx, project, msg, []string{board.OperatorName}))
		return msg.ID
	}
	reply := func(project, content string, replyTo int64) (int, map[string]any) {
		t.Helper()
		resp := postJSON(t, server.URL+"/api/board/"+project+"/messages", map[string]any{"subscriber_id": board.OperatorName, "as": "Operator", "content": content, "reply_to": replyTo})
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		require.NoError(t, json.Unmarshal(b, &out))
		return resp.StatusCode, out
	}
	last := func(project string) string {
		t.Helper()
		msgs, err := h.bs.ListMessages(ctx, project, 1, 0, 0)
		require.NoError(t, err)
		require.NotEmpty(t, msgs)
		return msgs[len(msgs)-1].Content
	}

	id := ask("team", "Coral")
	code, out := reply("team", "@Coral We want it to be an automation in coral", id)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "@Orchestrator We want it to be an automation in coral", last("team"), "addressed to the Orchestrator, the words as typed")

	code, out = reply("team", "We want it to be an automation in coral", ask("team", "Coral")) // no @ at all
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "We want it to be an automation in coral", last("team"))

	// a team with no Orchestrator: the words post with no mention
	_, err = h.bs.Subscribe(ctx, "solo", "Dev", "Developer", "claude-44444444-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	code, out = reply("solo", "@Coral Not now", ask("solo", "Coral"))
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "Not now", last("solo"))

	// a question of a member keeps its asker's @name, and a mention of someone who is nobody is still refused
	mq, err := h.bs.PostMessage(ctx, "team", "Dev", "@Operator ship it?", nil)
	require.NoError(t, err)
	require.NoError(t, h.bs.RecordAsk(ctx, "team", mq, []string{board.OperatorName}))
	code, out = reply("team", "@Dev yes", mq.ID)
	require.Equal(t, 200, code, "%v", out)
	assert.Equal(t, "@Dev yes", last("team"))
	// a reply to the Operator's own or a hub person's message keeps its mention: the rewrite is for Coral's two system senders only, because the mention decides who the reply reaches
	for _, from := range []string{board.OperatorName, "hub:alice", "Coral Task Queue"} {
		m, err := h.bs.PostSystemDefusedMessage(ctx, "team", from, "A question.", nil)
		require.NoError(t, err)
		require.NoError(t, h.bs.RecordAsk(ctx, "team", m, []string{board.OperatorName}))
		before := last("team")
		code, out = reply("team", "@"+from+" thanks", m.ID)
		if from == board.OperatorName { // a name that is a member of every team's view: stored as typed
			require.Equal(t, 200, code, "%v", out)
			assert.Equal(t, "@Operator thanks", last("team"))
			continue
		}
		assert.Equal(t, 400, code, "the mention of %s is kept, so it is refused as before: %v", from, out)
		assert.Equal(t, "unknown_mention", out["code"])
		assert.Equal(t, before, last("team"), "nothing was rewritten or stored for %s", from)
	}
	assert.Equal(t, "@Orchestrator Fine", func() string { // the health monitor's own sender is a system sender too
		m, err := h.bs.PostSystemDefusedMessage(ctx, "team", board.HealthMonitorSender, "@Operator limit hit.", nil)
		require.NoError(t, err)
		require.NoError(t, h.bs.RecordAsk(ctx, "team", m, []string{board.OperatorName}))
		code, out := reply("team", "@Coral Health Monitor Fine", m.ID)
		require.Equal(t, 200, code, "%v", out)
		return last("team")
	}())
	code, out = reply("team", "@Nobody here", id)
	assert.Equal(t, 400, code)
	assert.Equal(t, "unknown_mention", out["code"])
}
