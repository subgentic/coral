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

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #14860, the Operator: "Agents that have current tasks are getting messages through artifacts and it is disrupting work." A comment sent to an agent that is mid-turn (or has a task) is held, and posted
// as one message when the agent is free. A mock agent: its turn is the hook events (prompt_submit opens it, stop ends it).

func (rig *cmtRig) turn(n int, title, event string) {
	rig.t.Helper()
	id := sendSid(n)
	_, err := rig.h.ts.InsertAgentEvent(context.Background(), &store.AgentEvent{AgentName: title, SessionID: &id, EventType: event, Summary: event})
	require.NoError(rig.t, err)
}

func (rig *cmtRig) sendNow(cid int64, now bool, agents ...string) (int, map[string]any) {
	return rig.do("POST", fmt.Sprintf("%s/%d/send", cp(cmtDoc), cid), cmtAsOwner, map[string]any{"agents": agents, "now": now})
}

func (rig *cmtRig) askQueued(cid int64, n int) bool {
	rig.t.Helper()
	a, ok, err := rig.ss.GetArtifactAsk(context.Background(), cid, sendSid(n))
	require.NoError(rig.t, err)
	require.True(rig.t, ok)
	return a.QueuedAt != nil
}

func TestACommentForABusyAgentWaitsUntilItsTurnEnds(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "prompt_submit") // mid-turn
	cid := rig.ownerComment("Try 5,000 rows per batch.")
	code, out := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	assert.Equal(t, map[string]string{"Dev": "queued"}, states(out))
	assert.Empty(t, rig.operatorMessages(), "nothing is posted (so nothing is typed) while the agent is mid-turn")
	assert.True(t, rig.askQueued(cid, 1))

	rig.h.flushHeldComments(context.Background(), time.Now())
	assert.Empty(t, rig.operatorMessages(), "still mid-turn: still held")

	rig.turn(1, "Dev", "stop") // the turn ends
	rig.h.flushHeldComments(context.Background(), time.Now())
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "delivered when the agent is free")
	assert.Contains(t, msgs[0].Content, "Try 5,000 rows per batch.")
	assert.False(t, rig.askQueued(cid, 1), "no longer held")
	rig.h.flushHeldComments(context.Background(), time.Now())
	assert.Len(t, rig.operatorMessages(), 1, "delivered once")
}

func TestAFreeAgentGetsTheCommentAtOnce(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "stop")
	cid := rig.ownerComment("Looks good.")
	code, out := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	assert.Equal(t, map[string]string{"Dev": "sent"}, states(out))
	assert.Len(t, rig.operatorMessages(), 1)
	assert.False(t, rig.askQueued(cid, 1))
}

func TestSeveralHeldCommentsArriveAsOneMessageInOrder(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "prompt_submit")
	first := rig.ownerComment("FIRST-COMMENT")
	second := rig.ownerComment("SECOND-COMMENT")
	for _, c := range []int64{first, second} {
		code, out := rig.send(c, "Dev")
		require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
		require.Equal(t, map[string]string{"Dev": "queued"}, states(out))
	}
	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "one message for the agent, not one each")
	i, j := strings.Index(msgs[0].Content, "FIRST-COMMENT"), strings.Index(msgs[0].Content, "SECOND-COMMENT")
	assert.True(t, i >= 0 && j > i, "both, in the order they came: %q", msgs[0].Content)
	assert.False(t, rig.askQueued(first, 1) || rig.askQueued(second, 1))
}

func TestACommentForAnAgentWithATaskWaitsUnlessMarkedNow(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "stop") // idle at its prompt, but it has a task
	_, err := rig.h.bs.CreateTask(context.Background(), "team-a", "build it", "", "medium", "Operator", "Dev")
	require.NoError(t, err)
	claimed, err := rig.h.bs.ClaimTask(context.Background(), "team-a", naming.SubscriberID("Dev", "claude"))
	require.NoError(t, err)
	require.NotNil(t, claimed, "the agent's task is in progress")
	cid := rig.ownerComment("Plain comment.")
	_, out := rig.send(cid, "Dev")
	assert.Equal(t, map[string]string{"Dev": "queued"}, states(out), "a task is a reason to wait")
	rig.h.flushHeldComments(context.Background(), time.Now())
	assert.Empty(t, rig.operatorMessages(), "held for as long as the task lasts")

	urgent := rig.ownerComment("Urgent comment.")
	_, out = rig.sendNow(urgent, true, "Dev")
	assert.Equal(t, map[string]string{"Dev": "sent"}, states(out), "marked now: delivered at the idle prompt even with a task")
	assert.Len(t, rig.operatorMessages(), 1)
}

func TestNowNeverTypesMidTurn(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "prompt_submit")
	cid := rig.ownerComment("Right away, please.")
	_, out := rig.sendNow(cid, true, "Dev")
	assert.Equal(t, map[string]string{"Dev": "queued"}, states(out), "now still waits for the end of the turn")
	assert.Empty(t, rig.operatorMessages())
	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	assert.Len(t, rig.operatorMessages(), 1, "delivered at the next idle prompt")
}

func TestTheThreadSaysQueuedWhileACommentIsHeld(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.turn(1, "Dev", "prompt_submit")
	cid := rig.ownerComment("Hold this.")
	rig.send(cid, "Dev")
	queued := func() bool {
		code, out := rig.do("GET", cp(cmtDoc), cmtAsOwner, nil)
		require.Equal(t, http.StatusOK, code)
		for _, c := range out["comments"].([]any) {
			m := c.(map[string]any)
			if int64(m["id"].(float64)) != cid {
				continue
			}
			for _, a := range m["asks"].([]any) {
				if q, _ := a.(map[string]any)["queued"].(bool); q {
					return true
				}
			}
		}
		return false
	}
	assert.True(t, queued(), "the thread's ask is marked queued")
	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	assert.False(t, queued(), "and not any more once delivered")
}

// The comment written on an artifact reaches the uploader on its own (#11420): that path waits for a busy agent too, and says "queued" in its answer.
func TestTheOperatorsOwnCommentOnAnUploadWaitsForABusyUploader(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	rig.turn(1, "Dev", "prompt_submit")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Empty(t, out["sent_to"], "not sent yet")
	assert.Equal(t, "Dev", out["queued_for"], "the answer says it is queued for the uploader")
	assert.Empty(t, rig.operatorMessages(), "nothing posted, so nothing typed, mid-turn")
	cid := int64(out["id"].(float64))
	assert.True(t, rig.askQueued(cid, 1))
	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1)
	assert.Contains(t, msgs[0].Content, "Please use 5,000 rows per batch.")
	assert.Contains(t, msgs[0].Content, "The Operator commented on an artifact", "still the Operator's own request (#14855)")
	assert.True(t, msgs[0].IsSystem, "posted as Coral's notice, as the on-write delivery always was")
}

// #16850: a comment on an agent's changes or on a goal waits for a busy agent as an artifact comment does.
func TestADiffCommentForABusyAgentWaitsUntilItsTurnEnds(t *testing.T) {
	rig := newCmtRig(t)
	sid := rig.diffRig(1, "Dev", "pkg/a.go")
	rig.turn(1, "Dev", "prompt_submit")
	key := diffSubject("team-a", sid, "pkg/a.go")
	code, out := rig.do("POST", cp(key), cmtAsOwner, map[string]any{"body": "Why not wrap this error?", "anchor": diffAnchor("pkg/a.go", nil)})
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["queued_for"], fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "nothing is typed while the agent is mid-turn")

	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "delivered when the agent is free")
	assert.Contains(t, msgs[0].Content, "Why not wrap this error?")
	assert.Contains(t, msgs[0].Content, "pkg/a.go, lines 3-4")
}

func TestAGoalCommentForABusyDriverWaitsUntilItsTurnEnds(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "Orchestrator", false)
	path, _ := rig.goal("Dev")
	rig.turn(1, "Dev", "prompt_submit")
	code, out := rig.do("POST", path, cmtAsOwner, goalComment(nil))
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Dev", out["queued_for"], fmt.Sprint(out))
	assert.Empty(t, rig.operatorMessages(), "nothing is typed while the driver is mid-turn")

	rig.turn(1, "Dev", "stop")
	rig.h.flushHeldComments(context.Background(), time.Now())
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "delivered when the driver is free")
	assert.Contains(t, msgs[0].Content, "Please also cover the retries.")
}
