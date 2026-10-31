package ptymanager

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
)

// #11387: Coral's notices to one agent can be paused, or wait while the person types to it. They are held, not dropped and not typed; when the hold ends ONE line stands for them.

func noticeRig(t *testing.T, sid string) (*fakeAgent, func(what, text string) AutomatedInput) {
	t.Helper()
	a := &fakeAgent{screen: idleInputBox}
	name := "claude-" + sid
	t.Cleanup(func() { ForgetSession(name) })
	send := func(_ context.Context, _ AutomatedInput, text string) error { // the summary is typed where the fake agent records what it is given
		a.mu.Lock()
		a.typed = append(a.typed, text)
		a.mu.Unlock()
		return nil
	}
	summarySend.Store(&send)
	t.Cleanup(func() { summarySend.Store(nil); noticeClock.Store(nil); typingWindow.Store(0) })
	return a, func(what, text string) AutomatedInput {
		in := a.input(name, text, false)
		in.SessionID, in.What = sid, what
		return in
	}
}

func TestPausedNoticesAreHeldAndResumeTellsThemInOneLine(t *testing.T) {
	const sid = "11111111-1387-4000-8000-000000000001"
	a, in := noticeRig(t, sid)
	until := PauseNotices(sid, time.Hour)
	assert.WithinDuration(t, time.Now().Add(time.Hour), until, 5*time.Second)

	for _, tc := range []struct{ what, text string }{
		{"board message", "You have 1 unread message on the board"},
		{"board message", "You have 2 unread messages on the board"},
		{"remote board nudge", "A remote board nudge"},
		{"task notification", "[Task #7] was assigned to you"},
		{"task reminder", "[Task #7] is still open"},
	} {
		d, err := DeliverAutomated(context.Background(), in(tc.what, tc.text))
		require.NoError(t, err)
		assert.Equal(t, Skipped, d, "%s is held", tc.what)
	}
	_, err := DeliverAutomated(context.Background(), in("board message", "You have 1 unread message on the board")) // asked again: still one
	require.NoError(t, err)
	assert.Empty(t, a.sent(), "nothing was typed while paused")
	paused, _, waiting, _ := NoticeStatus(sid)
	assert.True(t, paused)
	assert.Equal(t, 5, waiting, "five distinct notices wait; one asked again counts once")

	notices.Lock()
	notices.m[sid].until = time.Time{} // the person resumed
	notices.Unlock()
	flushHeld(sid)
	assert.Equal(t, []string{"[Coral] While you were talking: 3 board messages, 2 tasks. Run coral-board read."}, a.sent(), "ONE line, counts and fixed words only")
	_, _, waiting, _ = NoticeStatus(sid)
	assert.Zero(t, waiting, "what was told is gone")
	flushHeld(sid)
	assert.Len(t, a.sent(), 1, "and is not told twice")

	d, err := DeliverAutomated(context.Background(), in("board message", "A notice after the resume"))
	require.NoError(t, err)
	assert.Equal(t, Sent, d, "after the resume notices are typed as before")
}

func TestTheCapEndsAPauseAndAnAskedLengthIsBounded(t *testing.T) {
	const sid = "11111111-1387-4000-8000-000000000002"
	a, in := noticeRig(t, sid)
	base := time.Now()
	setNoticeClock(base)
	until := PauseNotices(sid, 0)
	assert.Equal(t, base.Add(DefaultNoticePause), until, "no length: the default cap, 30 minutes, never for ever")
	assert.Equal(t, base.Add(MaxNoticePause), PauseNotices(sid, 100*time.Hour), "a long ask is cut at the longest")
	PauseNotices(sid, 10*time.Minute)

	d, _ := DeliverAutomated(context.Background(), in("board message", "inside the pause"))
	assert.Equal(t, Skipped, d)
	setNoticeClock(base.Add(11 * time.Minute)) // the cap passed
	flushHeld(sid)
	assert.Equal(t, []string{"[Coral] While you were talking: 1 board message. Run coral-board read."}, a.sent(), "the cap resumed it and the held one was told")
	paused, _, _, _ := NoticeStatus(sid)
	assert.False(t, paused)
	d, _ = DeliverAutomated(context.Background(), in("board message", "after the cap"))
	assert.Equal(t, Sent, d)
}

func TestTypingToAnAgentHoldsItsNoticesForSixtySecondsAfterTheLastKeystroke(t *testing.T) {
	const sid = "11111111-1387-4000-8000-000000000003"
	a, in := noticeRig(t, sid)
	typingWindow.Store(int64(80 * time.Millisecond))                                              // the window, shortened for the test
	terminalinput.Record(terminalinput.Person, "claude-"+sid+":0.0", terminalinput.Text, "hello") // a tmux pane named as the session is

	d, err := DeliverAutomated(context.Background(), in("board message", "while they type"))
	require.NoError(t, err)
	assert.Equal(t, Skipped, d, "held while the person types to this agent")
	_, _, _, typing := NoticeStatus(sid)
	assert.True(t, typing, "the row can say it is only the typing")
	assert.Empty(t, a.sent())

	time.Sleep(150 * time.Millisecond) // sleep-ok: the window is a wall-clock time
	flushHeld(sid)
	assert.Equal(t, []string{"[Coral] While you were talking: 1 board message. Run coral-board read."}, a.sent(), "when they stop, one line")

	other := "22222222-1387-4000-8000-000000000004"
	terminalinput.Record(terminalinput.Person, "claude-"+sid, terminalinput.Text, "x")
	assert.False(t, noticesHeld(other), "another agent's notices are not held by this one's typing")
}

func TestAPersonsOwnSendAndNonNoticesAreNeverHeld(t *testing.T) {
	const sid = "11111111-1387-4000-8000-000000000005"
	a, in := noticeRig(t, sid)
	PauseNotices(sid, time.Hour)

	d, err := DeliverNow(context.Background(), in("person send", "the person's own Send now"))
	require.NoError(t, err)
	assert.Equal(t, Sent, d, "the person's own send is never held")
	for _, what := range []string{"initial prompt", "automated /send", "automated /keys"} {
		d, err = DeliverAutomated(context.Background(), in(what, "not a notice: "+what))
		require.NoError(t, err)
		assert.Equal(t, Sent, d, "%s is not a notice", what)
	}
	assert.Len(t, a.sent(), 4)
}

func TestTheHeldSummaryHoldsOnlyCountsAndFixedWords(t *testing.T) {
	held := map[string]map[uint64]struct{}{
		"board message":     {1: {}},
		"some new sender":   {1: {}, 2: {}},
		"task notification": {1: {}, 2: {}, 3: {}},
	}
	line := heldSummary(held)
	assert.Equal(t, "[Coral] While you were talking: 1 board message, 2 notices, 3 tasks. Run coral-board read.", line)
	assert.False(t, strings.ContainsAny(line, "\n\r"), "one line")
}

func setNoticeClock(at time.Time) {
	f := func() time.Time { return at }
	noticeClock.Store(&f)
}
