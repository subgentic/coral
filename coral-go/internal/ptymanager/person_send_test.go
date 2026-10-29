package ptymanager

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// A person's send to an agent, and the text it leaves in the agent's box, keep Coral's own typing (a board nudge) and the turn-end hand-off away from that agent (#10996): they would start a turn or type into the box the
// person's Enter is competing with.
func TestPersonSendActiveWhileASendIsInFlightOrItsTextMayBeInTheBox(t *testing.T) {
	const sid = "11111111-0996-4000-8000-000000000001"
	assert.False(t, PersonSendActive(sid))
	end := BeginPersonSend(sid)
	end2 := BeginPersonSend(sid) // two sends queued for one agent
	assert.True(t, PersonSendActive(sid))
	end()
	assert.True(t, PersonSendActive(sid), "one of the two is still in flight")
	end()
	end2()
	assert.False(t, PersonSendActive(sid), "ending twice changes nothing")
	assert.False(t, PersonSendActive("22222222-0996-4000-8000-000000000002"), "another agent's is not this one's")

	NotePersonTextInBox(sid, true)
	assert.True(t, PersonSendActive(sid), "a message left in the box")
	NotePersonTextInBox(sid, false)
	assert.False(t, PersonSendActive(sid), "submitted or cleared")

	prev := personTextHoldNs.Load()
	personTextHoldNs.Store(int64(30 * time.Millisecond))
	t.Cleanup(func() { personTextHoldNs.Store(prev) })
	NotePersonTextInBox(sid, true)
	time.Sleep(60 * time.Millisecond) // sleep-ok: the hold is a wall-clock time
	assert.False(t, PersonSendActive(sid), "a left-over mark does not suppress Coral for ever: it lapses")
	assert.False(t, PersonSendActive(""), "no session id: never")
	NotePersonTextInBox("", true)
	assert.False(t, PersonSendActive(""))
}

func TestAnAutomatedSendWaitsOutAPersonsSendInFlight(t *testing.T) {
	n, sid := "claude-t-person-send", "33333333-0996-4000-8000-000000000003"
	defer ForgetSession(n)
	a := &fakeAgent{screen: idleInputBox}
	in := a.input(n, "You have 1 unread message", false)
	in.SessionID = sid

	end := BeginPersonSend(sid)
	d, err := DeliverAutomated(context.Background(), in)
	assert.NoError(t, err)
	assert.Equal(t, Skipped, d, "not typed while a person's send is in flight")
	assert.Empty(t, a.sent())
	assert.Zero(t, a.enters)
	_, kept := SkippedOf(n)
	assert.False(t, kept, "nothing was withheld from the person's view: no skip is recorded")
	end()

	d, err = DeliverAutomated(context.Background(), in)
	assert.NoError(t, err)
	assert.Equal(t, Sent, d, "typed once the send is over")
	assert.Equal(t, []string{"You have 1 unread message"}, a.sent())

	// The person's own send now (the dashboard's Send now) is never held back by it.
	b := &fakeAgent{screen: idleInputBox}
	forced := b.input(n, "mine", false)
	forced.SessionID = sid
	end = BeginPersonSend(sid)
	defer end()
	d, err = DeliverNow(context.Background(), forced)
	assert.NoError(t, err)
	assert.Equal(t, Sent, d)
}
