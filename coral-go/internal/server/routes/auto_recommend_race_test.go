package routes

import (
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/terminalinput"
)

// QA's three SHOULDs on the auto-recommend pick: the checks it makes again INSIDE the agent's lock (the live call, the person's presence, the record's option) and the rule of two passes are the
// promise of the file's comment, and each could be weakened or deleted with every test green. These tests change the world between the pass that bound the question and the lock, from the first
// screen read inside the lock (the terminal's capture hook), and so go red when the check is gone. Each also has its control: the same pick with nothing changed sends the digit.

// pickAfter runs one pick of the rig's question as the pass that bound it would (a question seen long enough, passes to spare), with `between` run once, right after the pick's first screen read
// inside the lock.
func (r *recRig) pickAfter(t *testing.T, between func()) {
	t.Helper()
	now := r.t0.Add(time.Minute)
	call, _ := r.h.liveQuestion(r.sid, now)
	require.NotEmpty(t, call, "the rig has one live question call")
	b := recBound{call: call, since: now.Add(-time.Hour), passes: 5}
	screen, shown, _, err := r.h.readPromptScreenText(r.ctx, r.pane, "claude", r.sid)
	require.NoError(t, err)
	require.True(t, shown)
	b.ask = screen.AskID
	if between != nil {
		var once sync.Once
		r.term.onCapture = func(string) { once.Do(between) }
	}
	r.rec.pick(r.ctx, liveAgent{sid: r.sid, name: r.pane, agentType: "claude", board: r.board}, b, now)
	r.rec.notices.Wait()
	r.term.mu.Lock()
	r.term.onCapture = nil
	r.term.mu.Unlock()
}

func TestAutoRecommendPickWithNothingChangedSendsTheDigit(t *testing.T) {
	r := newRecRig(t, "00c0", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.pickAfter(t, nil)
	assert.Equal(t, []string{"1"}, r.raw(), "the control of the three tests below")
}

// (a) The live call is read again inside the lock: another call (the agent asked something else, same words) between the pass and the lock is not the call the question was waited on for.
func TestAutoRecommendPicksNothingWhenTheLiveCallChangesBeforeTheLock(t *testing.T) {
	r := newRecRig(t, "00c1", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.pickAfter(t, func() {
		r.h.pending.callDone(r.sid, r.callID)
		r.h.pending.set(r.sid, r.call("toolu_q2", "AskUserQuestion", 0)) // the same question, but another call
	})
	assert.Empty(t, r.raw(), "the call is not the one the question was bound to")
	assert.Empty(t, r.typed(), "and no notice")
}

// (b) The person's presence is read again inside the lock, both ways a person is present.
func TestAutoRecommendPicksNothingWhenAPersonArrivesBeforeTheLock(t *testing.T) {
	r := newRecRig(t, "00c2", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.pickAfter(t, func() {
		r.h.focus.note(r.sid, "view-1", true, r.t0.Add(time.Minute)) // the person opens its terminal in the dashboard
	})
	assert.Empty(t, r.raw(), "a focused terminal view is a person at the agent (the notice gate does not see it: only this check does)")

	r2 := newRecRig(t, "00c3", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r2.pickAfter(t, func() {
		terminalinput.Record(terminalinput.Person, r2.pane, terminalinput.Keys, "x Enter") // the person types at the terminal
	})
	assert.Empty(t, r2.raw(), "a person typed at the terminal between the pass and the lock")
	assert.Empty(t, r2.typed())
}

// (b) The record's option is read again inside the lock: the same call, rewritten so that it no longer lists the picked label at the picked position.
func TestAutoRecommendPicksNothingWhenTheRecordNoLongerListsThePickedOption(t *testing.T) {
	r := newRecRig(t, "00c4", recQuestion("Which color?", "Red (Recommended)", "Green"))
	r.pickAfter(t, func() {
		r.h.pending.set(r.sid, r.callAbout(r.callID, "AskUserQuestion", 0, r.question, "Blue", "Green"))
	})
	assert.Empty(t, r.raw(), "the record (the same call, the same question) does not list the picked label at its position")
}

// (c) The same question must be seen in two passes before it is picked, however long the first look was ago: the first pass that finds a bound question old enough still only counts.
func TestAutoRecommendNeedsTwoPassesEvenWhenTheGraceIsOver(t *testing.T) {
	r := newRecRig(t, "00c5", recQuestion("Which color?", "Red (Recommended)", "Green"))
	screen, shown, _, err := r.h.readPromptScreenText(r.ctx, r.pane, "claude", r.sid)
	require.NoError(t, err)
	require.True(t, shown)
	at := r.t0.Add(time.Hour)
	call, _ := r.h.liveQuestion(r.sid, r.t0)
	require.NotEmpty(t, call)
	r.h.pending.set(r.sid, r.call(r.callID, "AskUserQuestion", time.Hour)) // the record stays live at the pass time
	// the question was first seen an hour ago, in no pass that counted: the grace is long over, but this is the first pass
	r.rec.mu.Lock()
	r.rec.bound[r.sid] = recBound{ask: screen.AskID, call: call, since: r.t0, passes: 0}
	r.rec.mu.Unlock()
	r.h.dialogPass(r.ctx, at)
	r.rec.notices.Wait()
	assert.Empty(t, r.raw(), "one pass is not two")
	r.h.dialogPass(r.ctx, at.Add(15*time.Second))
	r.rec.notices.Wait()
	assert.Equal(t, []string{"1"}, r.raw(), "the second pass picks: the rig itself is sound")
}
