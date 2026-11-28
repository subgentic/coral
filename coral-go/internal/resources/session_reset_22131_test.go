package resources

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #22131: a session reset (Claude's SessionStart after a compaction or a resume sends session_reset) gave back every hold of the session, so a background `claim --run` that still ran was refused at its next
// renew and stopped ("lost its slot"): 5 holds that were renewing ended "gone" on 11-28. A hold whose run is alive now stays with the run; one whose run is gone still goes.
func TestASessionResetKeepsAHoldWhoseRunStillRuns(t *testing.T) {
	alive := map[int]bool{4242: true}
	g := newHookRig(t, func(o *Options) { o.PidAlive = func(pid int) bool { return alive[pid] } })
	ctx := context.Background()
	_, err := g.m.ClaimRun(ctx, "mac-heavy", "Agent A", "go test", "run-1", 4242)
	require.NoError(t, err)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{"call-1"}, 0, 0) // the claim's tool call, as the hook binds it

	g.h.SessionEnded("s-a") // the compaction's SessionStart
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the run still runs: its slot stays")
	_, err = g.m.Queue().Renew("mac-heavy", "Agent A")
	assert.NoError(t, err, "and its next renew is taken, so the run is not stopped")

	alive[4242] = false // the run's process ended without giving the slot back
	g.add(time.Second)
	assert.Empty(t, g.holders(), "Reap gives back the slot of a run that is gone")
	end, ok := g.m.Queue().LastEnd("mac-heavy", "Agent A")
	require.True(t, ok)
	assert.Equal(t, "run gone", end.Why)
	assert.Equal(t, g.clock(), end.At)
}

func TestASessionResetStillGivesBackAHoldWithNoLiveRun(t *testing.T) {
	g := newHookRig(t, func(o *Options) { o.PidAlive = func(int) bool { return false } })
	g.handClaim("s-b", "Agent B", "call-9") // a plain claim in a tool call: nothing runs under it
	g.h.SessionEnded("s-b")
	assert.Empty(t, g.holders(), "a session's plain claim still goes when the session resets or ends")
	end, ok := g.m.Queue().LastEnd("mac-heavy", "Agent B")
	require.True(t, ok)
	assert.Equal(t, "released", end.Kind)
	assert.Equal(t, "gone", end.Why, "and the end is kept with its reason, for the refused renew to tell")
}

// A `claim --wait --run` still in line keeps its place at a session reset while its process waits (the compaction at 05:26 cancelled Backend Dev's place, "gone", after 10 min in line).
func TestASessionResetKeepsAPlaceInLineWhoseRunStillWaits(t *testing.T) {
	alive := map[int]bool{4242: true, 5151: true}
	g := newHookRig(t, func(o *Options) { o.PidAlive = func(pid int) bool { return alive[pid] } })
	ctx := context.Background()
	_, err := g.m.ClaimRun(ctx, "mac-heavy", "Agent B", "go test", "run-b", 5151) // holds the one slot
	require.NoError(t, err)
	_, err = g.m.ClaimRun(ctx, "mac-heavy", "Agent A", "go test", "run-a", 4242) // waits behind it
	require.NoError(t, err)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{"call-1"}, 0, 0)
	require.Len(t, g.queue(), 1)

	g.h.SessionEnded("s-a")
	require.Len(t, g.queue(), 1, "the waiting run's place stays")
	assert.Equal(t, "Agent A", g.queue()[0].Agent)

	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{"call-2"}, 0, 0)
	alive[4242] = false // a waiter whose process is gone still loses its place at a reset
	g.h.SessionEnded("s-a")
	assert.Empty(t, g.queue())
}
