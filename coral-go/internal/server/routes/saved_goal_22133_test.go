package routes

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #22133: the Saved list answers the goal (id and title) of a saved board message whose task has one, derived when it is read, one query per board; an agent's message, a message on no goal, and a board
// that cannot be asked answer none.
func TestTheSavedListAnswersABoardMessagesGoal(t *testing.T) {
	g := newSavedRig(t)
	var asked []string
	g.h.SetSavedGoals(func(_ context.Context, project string, ids []int64) (map[int64]board.MessageGoal, error) {
		asked = append(asked, project)
		if project == "broken" {
			return nil, errors.New("board unreadable")
		}
		out := map[int64]board.MessageGoal{}
		for _, id := range ids {
			if project == "teamA" && id == 7 {
				out[id] = board.MessageGoal{ID: 330, Title: "Finished results reach Needs you"}
			}
		}
		return out, nil
	})
	saveBoard(g, "teamA", "7")
	saveBoard(g, "teamA", "8")
	saveBoard(g, "broken", "7")
	saveAgent(g, sess1, "0123456789abcdef0123")

	_, list := g.do("GET", "/api/saved", savedAsOperator, nil)
	items, _ := list["items"].([]any)
	require.Len(t, items, 4)
	goals := map[string]any{}
	for _, raw := range items {
		it := raw.(map[string]any)
		goals[it["kind"].(string)+":"+it["ref"].(string)+"/"+it["key"].(string)] = it["goal"]
	}
	assert.Equal(t, map[string]any{"id": float64(330), "title": "Finished results reach Needs you"}, goals["board:teamA/7"])
	assert.Nil(t, goals["board:teamA/8"], "a message on no goal answers none")
	assert.Nil(t, goals["board:broken/7"], "a board that cannot be asked answers none")
	assert.Nil(t, goals["agent:"+sess1+"/0123456789abcdef0123"], "an agent's message is on no board task")
	assert.ElementsMatch(t, []string{"teamA", "broken"}, asked, "one query per board")

	asked = nil
	g.do("GET", "/api/saved?limit=0", savedAsOperator, nil)
	assert.Empty(t, asked, "the badge's count asks nothing")
}

// A saved file that is decided keeps "saved" (#22133), and still comes back to Needs you for a reply in its thread, like any decided file; a saved file still waiting stays out.
func TestADecidedSavedFileComesBackForAReply(t *testing.T) {
	assert.False(t, needsYouFile([]string{"for review", "saved"}, 0))
	assert.False(t, needsYouFile([]string{"for review", "saved"}, 2), "saved for later: out of Needs you, replies or not")
	assert.False(t, needsYouFile([]string{"approved", "saved"}, 0))
	assert.True(t, needsYouFile([]string{"approved", "saved"}, 1), "a decided saved file is back for a reply")
	assert.True(t, needsYouFile([]string{"denied", "saved"}, 1))
	assert.True(t, decidedWithNews([]string{"approved", "saved"}, 1))
	assert.False(t, needsYouFile([]string{"approved", "saved", "superseded"}, 1))
}
