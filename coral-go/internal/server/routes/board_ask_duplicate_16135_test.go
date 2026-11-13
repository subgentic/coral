package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #16135: an agent re-ran post --ask and the Operator got one question twice (#210160, #210164). The same sender's identical question to the Operator, while the first is still open,
// is not posted again: the answer is the first one's id with duplicate=true and nothing is stored. --again posts it anyway; a closed, answered or different question, or another sender's, is a new post.
func TestAnIdenticalOpenAskToTheOperatorIsNotPostedTwice(t *testing.T) {
	post, count, h, _ := buttonRig(t)
	ask := func(who, text string, extra map[string]any) (int, map[string]any) {
		p := map[string]any{"subscriber_id": who, "content": text, "ask": true}
		for k, v := range extra {
			p[k] = v
		}
		return post(p)
	}
	status, first := ask("Lead", "@Operator Ship the release?", nil)
	require.Equal(t, http.StatusOK, status, first)
	require.NotNil(t, first["id"])
	require.Nil(t, first["duplicate"], "the first one is a post")
	before := count()

	status, again := ask("Lead", "@Operator Ship the release?", nil)
	require.Equal(t, http.StatusOK, status, again)
	assert.Equal(t, first["id"], again["id"], "the open one's id comes back")
	assert.Equal(t, true, again["duplicate"])
	assert.Contains(t, again["message"], "Already asked as #")
	assert.Equal(t, before, count(), "nothing was stored")
	_, rows, _ := readOperatorAsks(t, h, asPerson)
	assert.Len(t, rows, 1, "one row in Needs you")

	status, other := ask("Dev", "@Operator Ship the release?", nil)
	require.Equal(t, http.StatusOK, status, other)
	assert.Nil(t, other["duplicate"], "another sender's identical question is its own")
	status, diff := ask("Lead", "@Operator Ship the release now?", nil)
	require.Equal(t, http.StatusOK, status, diff)
	assert.Nil(t, diff["duplicate"], "different text is a different question")

	status, forced := ask("Lead", "@Operator Ship the release?", map[string]any{"again": true})
	require.Equal(t, http.StatusOK, status, forced)
	assert.Nil(t, forced["duplicate"], "--again posts it anyway")
	assert.NotEqual(t, first["id"], forced["id"])

	// Closed (withdrawn or answered elsewhere): the next identical one is a new question again.
	require.NoError(t, h.bs.CloseAsk(context.Background(), "btnboard", int64(forced["id"].(float64)), "Lead", "withdrawn by Lead"))
	require.NoError(t, h.bs.CloseAsk(context.Background(), "btnboard", int64(first["id"].(float64)), "Lead", "withdrawn by Lead"))
	status, after := ask("Lead", "@Operator Ship the release?", nil)
	require.Equal(t, http.StatusOK, status, after)
	assert.Nil(t, after["duplicate"], "the earlier ones are closed")
}

// A question to someone else is not an Operator ask: asking a member twice is the asker's business, as before.
func TestAnIdenticalAskToAMemberIsStillPosted(t *testing.T) {
	post, _, _, _ := buttonRig(t)
	for i := 0; i < 2; i++ {
		status, out := post(map[string]any{"subscriber_id": "Lead", "content": "@Dev ready?", "ask": true})
		require.Equal(t, http.StatusOK, status, out)
		assert.Nil(t, out["duplicate"])
	}
}
