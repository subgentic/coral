package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
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
	assert.Contains(t, out["message"], "a line is")
	assert.Contains(t, out["message"], "one-line summary")
	assert.Contains(t, out["message"], "one point or step per line")
	assert.Zero(t, stored(), "nothing is posted on that error")

	out = post("Orchestrator", wall, true, 400)
	assert.Equal(t, "operator_format", out["code"], "an ask to the Operator too")
	out = post("Orchestrator", "Question for you, @Operator: "+strings.Repeat("is the release ready and are the notes written? ", 8), true, 400)
	assert.Equal(t, "operator_format", out["code"], "an ask is to the Operator by who it asks, not by where the tag stands")

	out = post("Lead", "@Operator short summary: 1. open the page 2. press Approve 3. say so", false, 400)
	assert.Equal(t, "operator_format", out["code"], "inline numbered steps, however short")
	assert.Contains(t, out["message"], "numbered steps")
	assert.Zero(t, stored())

	// the limit is on a line: 280 characters pass, 281 are refused
	post("Lead", "@Operator "+strings.Repeat("a", 270), false, 200)
	out = post("Lead", "@Operator "+strings.Repeat("a", 271), false, 400)
	assert.Equal(t, "operator_format", out["code"])
	assert.Contains(t, out["message"], "a line is 281 characters")

	n := stored()
	post("Lead", "@Operator release v2.0.37 is ready\n1. open the page\n2. press Approve", false, 200)
	post("Lead", "@Operator one short line, no steps", false, 200)
	post("Lead", "@Operator see section 3. The rest is in the artifact", false, 200)
	post("Lead", "@Operator 1. a 3. b", false, 200)                                                                 // not consecutive: not steps run together
	post("Lead", "@Operator summary\n"+strings.Repeat("a point of about forty characters here.\n", 20), false, 200) // a long text laid out in short lines
	post("Lead", "@Operator the report\ncoral://artifacts/"+strings.Repeat("a", 300), false, 200)                   // a line that is only a link
	post("Lead", "@Operator the command\n`"+strings.Repeat("go test ./... ", 30)+"`", false, 200)                   // a line that is only a code span
	post("Lead", "@Orchestrator "+strings.Repeat("a long note for an agent with no line break at all ", 8), false, 200)
	post("Lead", "@Orchestrator "+strings.Repeat("a long note, ", 30)+"cc @Operator", false, 200) // a passing @Operator inside a note to an agent
	assert.Equal(t, n+9, stored(), "good messages, and notes not to the Operator, are made")

	// the Operator's own long line is theirs to write
	post("Operator", wall, false, 200)
}

// The Operator's own message through Coral Hub is theirs to write too: a long line passes.
func TestTheOperatorsOwnLongLineThroughTheHubIsMade(t *testing.T) {
	server, handler := setupBoardTestServer(t)
	_, err := handler.bs.Subscribe(context.Background(), "p", "Dev", "Backend Dev", "s2", nil, "")
	require.NoError(t, err)
	handler.SetHubOperatorAllowed(func(r *http.Request) bool { return cloud.TunneledAuthentic(r) })
	body, _ := json.Marshal(map[string]any{"subscriber_id": "Operator", "as": "Operator", "content": "@Dev " + strings.Repeat("please look at the build and say what you see. ", 12)})
	req, _ := http.NewRequest("POST", server.URL+"/api/board/p/messages", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	stamp(req)
	req.Header.Add(tunnel.HubUserHeader, "hub-user-1234abcd")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))
	assert.Equal(t, board.OriginHubOperator, out["origin"])
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
	for _, tc := range [][2]string{{"Orchestrator", "@Operator release ready\n1. open it\n2. press Approve"}, {"Orchestrator", "@Lead " + strings.TrimPrefix(wall, "@Operator ")}, {"Orchestrator", "@Lead " + strings.Repeat("a note, ", 40) + "cc @Operator"}, {"Operator", wall}} {
		code, _ = refusal(tc[0], tc[1])
		assert.Zero(t, code, tc[1])
	}
}
