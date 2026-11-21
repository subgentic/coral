package routes

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #20240, the Operator: "we should just send them all at once". A bundle of comments (Send N open comments) reaches the agent as ONE message, in order, with every thread's reply command in it; a busy
// agent keeps the whole bundle held, as one delivery. Only past the size cap is it more than one message, and the answer says how many.

func (rig *cmtRig) sendBundle(cid int64, last bool, agents ...string) (int, map[string]any) {
	return rig.do("POST", fmt.Sprintf("%s/%d/send", cp(cmtDoc), cid), cmtAsOwner, map[string]any{"agents": agents, "bundle": true, "last": last})
}

func TestABundleReachesAFreeAgentAsOneMessage(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "stop")
	ids := []int64{rig.ownerComment("ONE-COMMENT"), rig.ownerComment("TWO-COMMENT"), rig.ownerComment("THREE-COMMENT")}
	var out map[string]any
	for i, c := range ids {
		code, o := rig.sendBundle(c, i == len(ids)-1, "Dev")
		require.Equal(t, http.StatusOK, code, fmt.Sprint(o))
		out = o
	}
	assert.Equal(t, map[string]string{"Dev": "sent"}, states(out), "the last answer says the bundle was delivered")
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "one message for all three, not one each")
	c := msgs[0].Content
	i, j, k := strings.Index(c, "ONE-COMMENT"), strings.Index(c, "TWO-COMMENT"), strings.Index(c, "THREE-COMMENT")
	assert.True(t, i >= 0 && j > i && k > j, "in the order they were sent: %q", c)
	for _, id := range ids {
		assert.Contains(t, c, fmt.Sprintf("coral://artifacts/%s %d ", cmtDoc, id), "each thread's reply command is in the message")
		assert.False(t, rig.askQueued(id, 1), "no comment is still held")
	}
	assert.Equal(t, float64(1), out["messages"])
}

func TestABundleForABusyAgentWaitsAsOneDelivery(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "prompt_submit")
	ids := []int64{rig.ownerComment("ONE-COMMENT"), rig.ownerComment("TWO-COMMENT")}
	var out map[string]any
	for i, c := range ids {
		_, out = rig.sendBundle(c, i == len(ids)-1, "Dev")
	}
	assert.Equal(t, map[string]string{"Dev": "queued"}, states(out))
	assert.Empty(t, rig.operatorMessages(), "nothing is typed mid-turn")
	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	require.Len(t, rig.operatorMessages(), 1, "the whole bundle in one message when the agent is free")
}

func TestABundlePastTheSizeCapIsSplitAndSaysSo(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "stop")
	long := strings.Repeat("word ", 150) // each message of the bundle is about 2 KiB: five of them are over 8 KiB
	var ids []int64
	for i := 0; i < 8; i++ {
		ids = append(ids, rig.ownerComment(fmt.Sprintf("C%d %s", i, long)))
	}
	var out map[string]any
	for i, c := range ids {
		_, out = rig.sendBundle(c, i == len(ids)-1, "Dev")
	}
	msgs := rig.operatorMessages()
	require.Greater(t, len(msgs), 1, "past the cap it is more than one message")
	for _, m := range msgs {
		assert.LessOrEqual(t, len(m.Content), heldMessageCap+400, "each part stays near the cap")
	}
	assert.Equal(t, float64(len(msgs)), out["messages"], "the answer says how many messages it took")
	assert.Equal(t, map[string]string{"Dev": "sent"}, states(out))
}
