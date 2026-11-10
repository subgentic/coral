package routes

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #15034 (the Operator: comment threads go silent): QA's repro on v2.0.62 and lead-v2064. The agent's reply cap is per Operator turn, a read of a delivered comment by any path stamps it, a held delivery says why,
// and the Operator may answer an agent's reply.

// An agent's replies in a thread are capped (an abuse limit); from the 6th round the reply was refused while the Operator's own reply still delivered, so the thread looked open and the agent could never answer.
func TestEachOperatorReplyGivesTheAgentItsRepliesAgain(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	cid := int64(out["id"].(float64))
	for round := 1; round <= 3; round++ { // three Operator turns, each answered with the most the agent may leave
		for i := 1; i <= store.MaxAskReplies; i++ {
			c, rep := rig.reply(cid, asAgentSession(1), fmt.Sprintf("round %d reply %d", round, i))
			require.Equal(t, http.StatusCreated, c, "round %d reply %d: %v", round, i, rep)
		}
		c, rep := rig.reply(cid, asAgentSession(1), "one too many")
		assert.Equal(t, http.StatusConflict, c, "the cap still holds inside one turn: %v", rep)
		assert.Equal(t, "reply_limit", rep["code"])
		c, rep = rig.ownerReply(cid, fmt.Sprintf("thanks, round %d", round))
		require.Equal(t, http.StatusCreated, c, fmt.Sprint(rep))
	}
}

func TestTheThreadSaysWhenTheAgentHasReachedItsReplyLimit(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	_, out := rig.commentAs(cmtAsOwner, nil)
	cid := int64(out["id"].(float64))
	for i := 0; i < store.MaxAskReplies; i++ {
		c, rep := rig.reply(cid, asAgentSession(1), fmt.Sprintf("reply %d", i))
		require.Equal(t, http.StatusCreated, c, fmt.Sprint(rep))
	}
	asks := rig.askViews(t, cid)
	require.Len(t, asks, 1)
	assert.Equal(t, true, asks[0]["limit_reached"], "the owner's thread says the agent has no replies left: %v", asks[0])
	rig.ownerReply(cid, "more please")
	asks = rig.askViews(t, cid)
	assert.NotEqual(t, true, asks[0]["limit_reached"], "the Operator's reply gave them back: %v", asks[0])
}

// An agent that uploaded the file and was never asked replies without an ask row (#13762): its cap counts the replies since the Operator's last comment.
func TestAnUploadersReplyCapIsPerOperatorTurnToo(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	cid := rig.quietRoot() // no notify: no ask row, the uploader replies on its own
	for i := 1; i <= store.MaxAskReplies; i++ {
		c, rep := rig.reply(cid, asAgentSession(1), fmt.Sprintf("r%d", i))
		require.Equal(t, http.StatusCreated, c, "reply %d: %v", i, rep)
	}
	c, rep := rig.reply(cid, asAgentSession(1), "one too many")
	require.Equal(t, http.StatusConflict, c, fmt.Sprint(rep))
	c, rep = rig.do("POST", cp(cmtDoc), cmtAsOwner, map[string]any{"body": "ok, go on", "parent_id": cid, "board": "team-a", "notify_agent": false})
	require.Equal(t, http.StatusCreated, c, fmt.Sprint(rep))
	c, rep = rig.reply(cid, asAgentSession(1), "after the Operator wrote")
	assert.Equal(t, http.StatusCreated, c, "the Operator's reply starts a new turn: %v", rep)
}

func TestWhenACommentIsNotDeliveredTheOperatorIsToldWhy(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	prev := rig.h.boardHandler
	rig.h.boardHandler = &BoardHandler{paused: map[string]bool{"team-a": true}}
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Empty(t, out["sent_to"])
	assert.Equal(t, "the board is paused", out["not_delivered"], "the comment stands and says why it went nowhere: %v", out)
	rig.h.boardHandler = prev
	code, out = rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["sent_to"])
	assert.Empty(t, out["not_delivered"], "a delivered comment says nothing of the kind")
}

func TestTheOperatorMayReplyToAnAgentsReply(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	_, out := rig.commentAs(cmtAsOwner, nil)
	root := int64(out["id"].(float64))
	c, rep := rig.reply(root, asAgentSession(1), "I changed it.")
	require.Equal(t, http.StatusCreated, c, fmt.Sprint(rep))
	agentReply := int64(rep["id"].(float64))
	c, rep = rig.ownerReply(agentReply, "Now the footer too.")
	require.Equal(t, http.StatusCreated, c, "answering the agent's reply was refused with 'that comment cannot be replied to': %v", rep)
	assert.Equal(t, float64(root), rep["parent_id"], "it belongs to the thread's first comment")
	assert.Equal(t, "Dev", rep["sent_to"], "and still reaches the agent")
	// the agent's own reply to the reply is still a reply to the root, never a second level
	for _, c := range rig.stored() {
		if c.ParentID != nil {
			assert.Equal(t, root, *c.ParentID)
		}
	}
}
