package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A message to the Operator is read on a phone: a wall of text (over 280 characters with no line break) or numbered steps run together on one line is refused with the way to format it, and
// nothing is stored (#12517). A message that is not to the Operator, one that is laid out as a summary and one point per line, and the Operator's own are made.
func TestAMessageToTheOperatorThatIsAWallOfTextIsRefused(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Lead", "Lead", "claude-33333333-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Operator", "Operator", "", nil, "all")
	require.NoError(t, err)
	post := func(who, content string, ask bool, want int) map[string]any {
		t.Helper()
		resp := postJSON(t, server.URL+"/api/board/team/messages", map[string]any{"subscriber_id": who, "content": content, "ask": ask})
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		require.Equal(t, want, resp.StatusCode, string(b))
		var out map[string]any
		require.NoError(t, json.Unmarshal(b, &out))
		return out
	}
	stored := func() int {
		msgs, err := h.bs.ListMessages(ctx, "team", 50, 0, 0)
		require.NoError(t, err)
		return len(msgs)
	}

	wall := "@Operator " + strings.Repeat("the release is ready and the notes are written ", 8)
	out := post("Orchestrator", wall, false, 400)
	assert.Equal(t, "operator_format", out["code"])
	assert.Equal(t, true, out["not_sent"])
	assert.Contains(t, out["message"], "one-line summary")
	assert.Contains(t, out["message"], "one point or step per line")
	assert.Zero(t, stored(), "nothing is posted on that error")

	out = post("Orchestrator", wall, true, 400)
	assert.Equal(t, "operator_format", out["code"], "an ask to the Operator too")

	out = post("Lead", "@Operator short summary: 1. open the page 2. press Approve 3. say so", false, 400)
	assert.Equal(t, "operator_format", out["code"], "inline numbered steps, however short")
	assert.Contains(t, out["message"], "numbered steps")
	assert.Zero(t, stored())

	post("Lead", "@Operator release v2.0.37 is ready\n1. open the page\n2. press Approve", false, 200)
	post("Lead", "@Operator one short line, no steps", false, 200)
	post("Lead", "@Operator see section 3. The rest is in the artifact", false, 200)
	post("Lead", "@Orchestrator "+strings.Repeat("a long note for an agent with no line break at all ", 8), false, 200)
	assert.Equal(t, 4, stored(), "good messages and one not to the Operator are made")

	// the Operator's own long line is theirs to write
	post("Operator", wall, false, 200)
}

// A cross-team message to the target team's Operator is held to the same layout; the sender being the Operator, or the text not being to the Operator, is not refused.
func TestACrossTeamMessageToTheOperatorThatIsAWallOfTextIsRefused(t *testing.T) {
	wall := "@Operator " + strings.Repeat("the release is ready and the notes are written ", 8)
	refusal := func(sender, content string) (int, map[string]any) {
		m := externalMessage{FromBoard: "a", SubscriberID: sender, Content: content}
		refused := m.refusal("b")
		if refused == nil {
			return 0, nil
		}
		rec := httptest.NewRecorder()
		refused(rec)
		var out map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out))
		return rec.Code, out
	}
	code, out := refusal("Orchestrator", wall)
	assert.Equal(t, 400, code)
	assert.Equal(t, "operator_format", out["code"])
	code, out = refusal("Orchestrator", "@Operator 1. open it 2. press Approve")
	assert.Equal(t, 400, code)
	assert.Equal(t, "operator_format", out["code"])
	for _, tc := range [][2]string{{"Orchestrator", "@Operator release ready\n1. open it\n2. press Approve"}, {"Orchestrator", "@Lead " + strings.TrimPrefix(wall, "@Operator ")}, {"Operator", wall}} {
		code, _ = refusal(tc[0], tc[1])
		assert.Zero(t, code, tc[1])
	}
}
