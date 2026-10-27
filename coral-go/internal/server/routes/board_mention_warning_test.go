package routes

import (
	"context"
	"encoding/json"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A post that mentions nobody on the board is refused and nothing is stored: the answer names the unknown mention and the closest
// member (#4583 rule 5, #9047). A post whose mentions are all members is made, with no warnings key. The refusal is the server's, so
// every client gets it.
func TestPostRefusesAnUnknownMentionAndStoresNothing(t *testing.T) {
	server, h := setupBoardTestServer(t)
	ctx := context.Background()
	_, err := h.bs.Subscribe(ctx, "team", "Digital Ocean Expert", "Cloud", "claude-11111111-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "team", "Orchestrator", "Orchestrator", "claude-22222222-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	_, err = h.bs.Subscribe(ctx, "coral-hub", "Lead", "Lead", "claude-33333333-0000-0000-0000-000000000000", nil, "all")
	require.NoError(t, err)
	post := func(content string, want int) map[string]any {
		t.Helper()
		resp := postJSON(t, server.URL+"/api/board/team/messages", map[string]string{"subscriber_id": "Orchestrator", "content": content})
		defer resp.Body.Close()
		require.Equal(t, want, resp.StatusCode)
		b, _ := io.ReadAll(resp.Body)
		var out map[string]any
		require.NoError(t, json.Unmarshal(b, &out))
		return out
	}
	stored := func() int {
		msgs, err := h.bs.ListMessages(ctx, "team", 10, 0, 0)
		require.NoError(t, err)
		return len(msgs)
	}

	out := post("@DO Expert is the droplet up?", 400)
	assert.Equal(t, "unknown_mention", out["code"])
	assert.Equal(t, true, out["not_sent"])
	assert.Equal(t, []any{"no subscriber named 'DO Expert'; did you mean 'Digital Ocean Expert'?"}, out["mentions"])
	assert.Contains(t, out["message"], "not posted: no subscriber named 'DO Expert'")
	assert.Zero(t, stored(), "nothing is posted on that error")

	out = post("@Orchestrator (coral-hub) the release is ready", 400)
	assert.Equal(t, "unknown_mention", out["code"])
	assert.Contains(t, out["message"], "coral-board send --board coral-hub")
	assert.Zero(t, stored())

	ok := post("@Digital Ocean Expert the droplet is yours, @all", 200)
	assert.NotContains(t, ok, "warnings")
	assert.NotNil(t, ok["id"])
	assert.Equal(t, 1, stored())
	post("no mention here", 200)
	post("the decorator @param is not a mention", 200)
	assert.Equal(t, 3, stored())
}
