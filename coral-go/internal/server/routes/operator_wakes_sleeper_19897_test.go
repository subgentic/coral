package routes

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #19897: what the Operator sends to an agent that is asleep wakes it, then is delivered. The Operator's report: a file sent back to Video Producer (put to sleep a few minutes before) sat unread, and the Inbox row
// said "Sent back · waiting on Video Producer" with nobody working. Only the Operator's own words wake a sleeper that a person put to sleep; an agent's message or a plain @mention never does.

// wakeable lets agent n's sleeping row be woken against a fake terminal: its pane is known and its input box is ready (what a real wake finds).
func (rig *cmtRig) wakeable(n int) {
	rig.t.Helper()
	var mock *mockSessionTerminal
	switch term := rig.h.terminal.(type) {
	case *mockSessionTerminal:
		mock = term
	case *autoSleepTerm: // an earlier agent of this rig already made it wakeable
		mock = term.mockSessionTerminal
	default:
		require.Fail(rig.t, "the rig's terminal is the mock")
	}
	mock.addSession(naming.SessionName("claude", sendSid(n)), rig.t.TempDir())
	if _, ok := rig.h.terminal.(*autoSleepTerm); !ok {
		rig.h.terminal = &autoSleepTerm{mockSessionTerminal: mock, screen: emptyBoxScreen}
	}
}

func (rig *cmtRig) awake(n int) bool {
	rig.t.Helper()
	ls, err := rig.ss.GetLiveSession(context.Background(), sendSid(n))
	require.NoError(rig.t, err)
	require.NotNil(rig.t, ls)
	return ls.IsSleeping == 0
}

func TestAnOperatorCommentWakesAManuallySleepingUploaderAndTheMessageIsThere(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Video Producer", true) // a person's Sleep
	rig.wakeable(1)
	rig.uploadedBy(1, "team-a")
	rig.tag("for review")
	code, out := rig.commentAs(cmtAsOwner, nil)
	require.Equal(t, http.StatusCreated, code, fmt.Sprint(out))
	assert.Equal(t, "Video Producer", out["sent_to"])
	assert.True(t, rig.awake(1), "the Operator's comment woke the sleeping agent")
	msgs := rig.operatorMessages()
	require.Len(t, msgs, 1, "and the message is on the board for it")
	assert.Contains(t, msgs[0].Content, "5,000 rows per batch")
}

func TestSendToAgentWakesAManuallySleepingAgentAndSendsToIt(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Video Producer", true)
	rig.wakeable(1)
	cid := rig.ownerComment("Shorten the pause")
	code, out := rig.send(cid, "Video Producer")
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	assert.Equal(t, map[string]string{"Video Producer": "sent"}, states(out))
	assert.True(t, rig.awake(1))
	assert.Len(t, rig.operatorMessages(), 1)
}

func TestAnArchivedAgentIsNotWokenByTheOperatorsWordsAndSaysSo(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Video Producer", true)
	rig.wakeable(1)
	require.NoError(t, rig.ss.SetSessionArchived(context.Background(), sendSid(1), true))
	cid := rig.ownerComment("Shorten the pause")
	code, out := rig.send(cid, "Video Producer")
	assert.Equal(t, http.StatusConflict, code, fmt.Sprint(out))
	assert.Equal(t, map[string]string{"Video Producer": "unavailable"}, states(out))
	assert.Empty(t, rig.operatorMessages())
	ls, _ := rig.ss.GetLiveSession(context.Background(), sendSid(1))
	assert.Equal(t, 1, ls.IsArchived)
	assert.Equal(t, 1, ls.IsSleeping, "an archived agent is gone: it is not started")
}

func TestAnAgentsMessageNeverWakesAManualSleeper(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Video Producer", true)
	rig.wakeable(1)
	assert.False(t, rig.h.WakeIdleForDelivery(context.Background(), sendSid(1)), "a delivery from an agent or Coral keeps a person's Sleep")
	assert.True(t, rig.h.WakeForOperator(context.Background(), sendSid(1)), "the Operator's own word wakes it")
	assert.True(t, rig.awake(1))
}

// #19901: Send all is the Operator's own press too: it wakes a sleeping agent whoever put it to sleep, and an archived one is not woken.
func TestSendAllWakesAManuallySleepingAgentAndAnArchivedOneIsNot(t *testing.T) {
	rig := newCmtRig(t)
	rig.agent(1, "Video Producer", true)
	rig.wakeable(1)
	rig.agent(2, "Gone", true)
	rig.wakeable(2)
	require.NoError(t, rig.ss.SetSessionArchived(context.Background(), sendSid(2), true))
	rig.ownerComment("Shorten the pause.")
	rig.ownerComment("Brighter intro.")
	code, out := rig.sendAll("Video Producer", "Gone")
	require.Equal(t, http.StatusOK, code, fmt.Sprint(out))
	assert.Equal(t, map[string]string{"Video Producer": "sent", "Gone": "unavailable"}, states(out))
	assert.True(t, rig.awake(1), "Send all woke the sleeping agent")
	ls, _ := rig.ss.GetLiveSession(context.Background(), sendSid(2))
	assert.Equal(t, 1, ls.IsSleeping, "an archived agent is not started")
	require.Len(t, rig.operatorMessages(), 1)
}
