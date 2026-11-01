package routes

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #11722 (the Operator: agents must answer where the person asked): a comment relayed to an agent is open until the agent replies in its thread; if ten minutes pass, or the agent posts on the board about the file
// without replying in the thread, Coral reminds it ONCE with the reply command; the owner's thread says "seen by <agent>" once the agent read the threads, and "reminded" once it was nudged.
type typedNudges struct {
	mu   sync.Mutex
	sent []string // "<project> <session> <text>"
}

func (n *typedNudges) send(_ context.Context, project, session, text string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.sent = append(n.sent, fmt.Sprintf("%s %s %s", project, session, text))
	return nil
}

func (n *typedNudges) count() int { n.mu.Lock(); defer n.mu.Unlock(); return len(n.sent) }

func TestAnUnansweredRelayedCommentIsRemindedOnceInTheThread(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	rig.agent(2, "QA", false)
	typed := &typedNudges{}
	rig.h.replyNudgeSend = typed.send
	ctx := context.Background()
	cid := rig.ownerComment("Try 5,000 rows per batch.")
	code, out := rig.send(cid, "Dev", "QA")
	require.Equal(t, http.StatusOK, code, "%v", out)
	now := time.Now()

	// Not due yet: nothing is typed, and the owner's list says nobody has seen it.
	rig.h.nudgeUnansweredComments(ctx, now.Add(2*time.Minute))
	assert.Equal(t, 0, typed.count(), "two minutes in: no reminder")
	asks := rig.askViews(t, cid)
	require.Len(t, asks, 2)
	for _, a := range asks {
		assert.Equal(t, false, a["seen"], "%v", a)
		assert.Equal(t, false, a["nudged"], "%v", a)
	}

	// Dev reads the thread (its token): "seen by Dev"; QA has not.
	code, _ = rig.do("GET", cp(cmtDoc)+"?state=all", map[string]string{testAgentHeader: sendSid(1)}, nil)
	require.Equal(t, http.StatusOK, code)
	seen := map[string]bool{}
	for _, a := range rig.askViews(t, cid) {
		seen[a["agent"].(string)] = a["seen"].(bool)
	}
	assert.Equal(t, map[string]bool{"Dev": true, "QA": false}, seen, "seen by the agent that read the threads")

	// Dev replies in the thread: it is answered, never reminded. QA does not: ten minutes later it is reminded, once, with the reply command.
	code, out = rig.do("POST", fmt.Sprintf("%s/%d/reply", cp(cmtDoc), cid), map[string]string{testAgentHeader: sendSid(1)}, map[string]any{"body": "Done, 5,000 works."})
	require.Equal(t, http.StatusCreated, code, "%v", out)
	rig.h.nudgeUnansweredComments(ctx, now.Add(11*time.Minute))
	require.Equal(t, 1, typed.count(), "only the agent that did not answer in the thread is reminded: %v", typed.sent)
	assert.Contains(t, typed.sent[0], "team-a")
	assert.Contains(t, typed.sent[0], "claude-"+sendSid(2))
	assert.Contains(t, typed.sent[0], fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d", cmtDoc, cid), "the exact reply command")
	rig.h.nudgeUnansweredComments(ctx, now.Add(40*time.Minute))
	assert.Equal(t, 1, typed.count(), "once: a second pass types nothing")
	nudged := map[string]bool{}
	for _, a := range rig.askViews(t, cid) {
		nudged[a["agent"].(string)] = a["nudged"].(bool)
	}
	assert.Equal(t, map[string]bool{"Dev": false, "QA": true}, nudged)
}

func TestAnAgentThatPostsAboutTheFileOnTheBoardButNotInTheThreadIsRemindedAtOnce(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	typed := &typedNudges{}
	rig.h.replyNudgeSend = typed.send
	ctx := context.Background()
	cid := rig.ownerComment("Why this batch size?")
	code, out := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code, "%v", out)
	now := time.Now()

	// A board post that is about something else: nothing.
	_, err := rig.h.bs.PostMessage(ctx, "team-a", "Dev", "unrelated status update", nil)
	require.NoError(t, err)
	rig.h.nudgeUnansweredComments(ctx, now.Add(time.Minute))
	assert.Equal(t, 0, typed.count(), "a post that does not name the file is no answer to it")

	// A board post that names the file: reminded now, not in ten minutes.
	_, err = rig.h.bs.PostMessage(ctx, "team-a", "Dev", "Answered the batch size question on coral://artifacts/"+cmtDoc, nil)
	require.NoError(t, err)
	rig.h.nudgeUnansweredComments(ctx, now.Add(2*time.Minute))
	require.Equal(t, 1, typed.count(), "%v", typed.sent)
	assert.Contains(t, typed.sent[0], fmt.Sprintf("coral-agent artifact reply coral://artifacts/%s %d", cmtDoc, cid))
}

func TestASleepingOrPausedAgentIsNotRemindedAndAGoneOneIsLookedAtAgain(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	typed := &typedNudges{}
	rig.h.replyNudgeSend = typed.send
	ctx := context.Background()
	cid := rig.ownerComment("Question.")
	code, _ := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code)
	require.NoError(t, rig.ss.SetSessionSleeping(ctx, sendSid(1), true))
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(30*time.Minute))
	assert.Equal(t, 0, typed.count(), "an agent that sleeps finds the message when it wakes")
	require.NoError(t, rig.ss.SetSessionSleeping(ctx, sendSid(1), false))
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(30*time.Minute))
	assert.Equal(t, 1, typed.count(), "awake again: reminded")
	_ = store.MaxAskReplies
}

// askViews are the asks the owner's list carries on a thread's first comment.
func (rig *cmtRig) askViews(t *testing.T, cid int64) []map[string]any {
	t.Helper()
	code, out := rig.do("GET", cp(cmtDoc)+"?state=all", cmtAsOwner, nil)
	require.Equal(t, http.StatusOK, code, "%v", out)
	for _, c := range out["comments"].([]any) {
		m := c.(map[string]any)
		if int64(m["id"].(float64)) == cid {
			var asks []map[string]any
			for _, a := range m["asks"].([]any) {
				asks = append(asks, a.(map[string]any))
			}
			return asks
		}
	}
	t.Fatalf("no comment %d", cid)
	return nil
}

// Security's INFOs on #11722: the reminder is marked BEFORE it is typed (so a failure to record cannot type it again every pass), a send that fails takes the mark back and a later pass tries again, and asks of
// sleeping or gone sessions do not fill the batch and starve newer ones.
func TestAReminderIsMarkedBeforeItIsTypedAndTakenBackWhenTheSendFails(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	ctx := context.Background()
	cid := rig.ownerComment("Question.")
	code, _ := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code)
	var duringSend, calls int
	fail := true
	rig.h.replyNudgeSend = func(c context.Context, project, session, text string) error {
		calls++
		waiting, err := rig.ss.AwaitingAsks(c, time.Now().Add(time.Hour), 10)
		require.NoError(t, err)
		duringSend = len(waiting) // 0 when the mark was made before typing
		if fail {
			return fmt.Errorf("the write failed")
		}
		return nil
	}
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(11*time.Minute))
	assert.Equal(t, 1, calls)
	assert.Equal(t, 0, duringSend, "marked before it was typed: nothing was waiting while the send ran")
	waiting, err := rig.ss.AwaitingAsks(ctx, time.Now().Add(time.Hour), 10)
	require.NoError(t, err)
	assert.Len(t, waiting, 1, "the send failed: the mark was taken back, the ask waits again")
	fail = false
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(12*time.Minute))
	assert.Equal(t, 2, calls, "a later pass tries again")
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(13*time.Minute))
	assert.Equal(t, 2, calls, "typed once, then never again")
}

func TestAsksOfSleepingOrGoneSessionsDoNotStarveANewerOne(t *testing.T) {
	rig := newCmtRig(t)
	ctx := context.Background()
	rig.agent(1, "Asleep", true)
	rig.agent(2, "Awake", false)
	for _, c := range []string{"one", "two", "three"} {
		cid := rig.ownerComment(c)
		_, _, err := rig.ss.CreateArtifactAsk(ctx, cid, cmtDoc, "team-a", sendSid(1), "Asleep", time.Now())
		require.NoError(t, err)
	}
	cid := rig.ownerComment("for the awake one")
	_, _, err := rig.ss.CreateArtifactAsk(ctx, cid, cmtDoc, "team-a", sendSid(2), "Awake", time.Now())
	require.NoError(t, err)
	// the batch of ONE: the three older asks belong to a sleeper and a stranger, so the awake agent's is still the one looked at
	got, err := rig.ss.AwaitingAsks(ctx, time.Now(), 1)
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, sendSid(2), got[0].AgentSession)
	// a session that is not live at all is not in the batch either
	_, _, err = rig.ss.CreateArtifactAsk(ctx, cid, cmtDoc, "team-a", "00000000-0000-4000-8000-00000000dead", "Gone", time.Now())
	require.NoError(t, err)
	got, err = rig.ss.AwaitingAsks(ctx, time.Now(), 10)
	require.NoError(t, err)
	for _, a := range got {
		assert.Equal(t, sendSid(2), a.AgentSession, "only the live awake agent's ask waits")
	}
}

// QA's SHOULDs on #11722: a paused board's ask is not reminded (nothing is typed into the agents of a paused board) and is, once the board is resumed; and the short form of the file's id (its first 12 characters, as
// a shortened link) counts as naming it, an 11-character prefix or another file's id does not.
func TestAPausedBoardsAskIsNotRemindedUntilItIsResumed(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	typed := &typedNudges{}
	rig.h.replyNudgeSend = typed.send
	bh := NewBoardHandler(rig.h.bs)
	rig.h.boardHandler = bh
	ctx := context.Background()
	cid := rig.ownerComment("Question.")
	code, _ := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code)
	bh.SetPaused("team-a", true)
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(30*time.Minute))
	assert.Equal(t, 0, typed.count(), "a paused board: nothing is typed into its agents")
	waiting, err := rig.ss.AwaitingAsks(ctx, time.Now().Add(time.Hour), 10)
	require.NoError(t, err)
	assert.Len(t, waiting, 1, "and the ask is still waiting, not marked as reminded")
	bh.SetPaused("team-a", false)
	rig.h.nudgeUnansweredComments(ctx, time.Now().Add(31*time.Minute))
	assert.Equal(t, 1, typed.count(), "resumed: reminded")
}

func TestTheShortFormOfTheFilesIDInABoardPostCountsAsNamingIt(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Dev", false)
	typed := &typedNudges{}
	rig.h.replyNudgeSend = typed.send
	ctx := context.Background()
	cid := rig.ownerComment("Question.")
	code, _ := rig.send(cid, "Dev")
	require.Equal(t, http.StatusOK, code)
	now := time.Now()
	post := func(text string) {
		_, err := rig.h.bs.PostMessage(ctx, "team-a", "Dev", text, nil)
		require.NoError(t, err)
	}
	// 11 characters of the id, and another file's id: not it
	post("see coral://artifacts/" + cmtDoc[:11] + " for the answer") // only the newest post is read, so one at a time
	rig.h.nudgeUnansweredComments(ctx, now.Add(time.Minute))
	assert.Equal(t, 0, typed.count(), "11 characters is not the short form")
	post("see coral://artifacts/" + cmtPic + " for the answer")
	rig.h.nudgeUnansweredComments(ctx, now.Add(90*time.Second))
	assert.Equal(t, 0, typed.count(), "another file's id is another file")
	// the first 12 characters: it
	post("see coral://artifacts/" + cmtDoc[:12] + " for the answer")
	rig.h.nudgeUnansweredComments(ctx, now.Add(2*time.Minute))
	assert.Equal(t, 1, typed.count(), "the 12-character short form names the file")
}
