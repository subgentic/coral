package routes

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// #17360 (walk 67): the person's comment on a file and an agent's reply in the thread are rows of Activity, with the file's name and the words, so a search for the comment finds them.
func TestACommentAndAnAgentsReplyAreActivityRows(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	cid := rig.ownerComment("Please add a Print button")
	_, out := rig.send(cid, "Dev")
	require.Equal(t, "sent", states(out)["Dev"])
	code, rep := rig.reply(cid, asAgentSession(1), "Added the Print button.")
	require.Equal(t, http.StatusCreated, code, "%v", rep)

	rows, err := rig.h.bs.ListActivity(context.Background(), board.ActivityFilter{Limit: 50})
	require.NoError(t, err)
	byAction := map[string]board.OperatorAction{}
	for _, r := range rows {
		byAction[r.Action] = r
	}
	c, ok := byAction[board.ActFileComment]
	require.True(t, ok, "the person's comment is a row: %+v", rows)
	assert.Equal(t, "plan.md", c.Title, "with the file's name")
	assert.Equal(t, "Please add a Print button", c.Note, "and the comment's words, so a search finds it")
	r, ok := byAction[board.ActFileReply]
	require.True(t, ok, "the agent's reply is a row: %+v", rows)
	assert.Equal(t, "Added the Print button.", r.Note)
	assert.Equal(t, "Dev", r.Asker, "it names the agent")
	assert.Equal(t, "agent:Dev", r.Actor)
}
