package resources

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13718, the Operator's design: a slot an agent claims by hand belongs to the tool call it was claimed in, and Coral gives it back when that call ends (or the agent's turn or session does): a forgotten release cannot hold the line.

func (g *hookRig) handClaim(session, agent, call string) {
	g.t.Helper()
	res, err := g.m.Claim(context.Background(), "mac-heavy", agent, "by hand")
	require.NoError(g.t, err)
	_ = res
	g.h.BindHand(session, agent, "mac-heavy", call, 0)
}

func TestAHandClaimIsGivenBackWhenItsToolCallEnds(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-1")
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.After("s-a", "call-2") // another call of the session ends: not this one
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.After("s-b", "call-1") // the same id in another session: not this one
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "the call ended: the slot went back with no release command")
}

func TestAWaitingHandClaimLeavesTheLineWhenItsCallEndsAndTheNextIsGranted(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a")
	g.handClaim("s-b", "Agent B", "call-b") // waits
	require.Len(t, g.queue(), 1)
	g.h.After("s-b", "call-b") // its --wait ended (timeout, cancel): it leaves the line, as today
	assert.Empty(t, g.queue())
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the holder is untouched")
	g.h.After("s-a", "call-a")
	assert.Empty(t, g.holders())
}

func TestAReleaseByHandThenAnotherClaimIsBoundToTheNewCall(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-1")
	require.NoError(t, g.m.Queue().Release("mac-heavy", "Agent A"))
	g.handClaim("s-a", "Agent A", "call-3")
	g.h.After("s-a", "call-1") // the old call ends late: the new hold is not its own
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.After("s-a", "call-3")
	assert.Empty(t, g.holders())
}

func TestTheEndOfATurnOrASessionGivesBackEveryHandClaim(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-1")
	g.h.TurnEnded("s-a") // the Stop: the safety net for a call that never reported its end
	assert.Empty(t, g.holders())
	g.handClaim("s-b", "Agent B", "call-9")
	g.h.SessionEnded("s-b")
	assert.Empty(t, g.holders(), "a crashed agent's claim is freed when its session ends")
}

func TestAClaimWithNoToolCallStaysUntilItsLease(t *testing.T) {
	g := newHookRig(t)
	_, err := g.m.Claim(context.Background(), "mac-heavy", "Operator", "")
	require.NoError(t, err) // the Operator's own command line: no call, no binding
	g.h.After("s-a", "call-1")
	g.h.TurnEnded("s-a")
	g.h.SessionEnded("s-a")
	assert.Equal(t, []string{"Operator"}, g.holders())
	g.add(31 * time.Minute)
	assert.Empty(t, g.holders(), "its lease ends it, as before")
}

// A job run in the background outlives its tool call (Claude's run_in_background, Codex's background terminal): the claim is also bound to the claiming shell's process and goes back only when BOTH the call has ended AND that process is gone.
func (g *hookRig) bgClaim(session, agent, call string, pid int) {
	g.t.Helper()
	_, err := g.m.Claim(context.Background(), "mac-heavy", agent, "bg")
	require.NoError(g.t, err)
	g.mu.Lock()
	g.pids[pid] = true
	g.mu.Unlock()
	g.h.BindHand(session, agent, "mac-heavy", call, pid)
}

func (g *hookRig) die(pid int) { g.mu.Lock(); delete(g.pids, pid); g.mu.Unlock() }

func TestABackgroundClaimLivesAsLongAsItsProcessAfterItsCallEnds(t *testing.T) {
	g := newHookRig(t)
	g.bgClaim("s-a", "Agent A", "call-1", 4242)
	g.h.After("s-a", "call-1") // the call returned at once, the job goes on
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the job still runs: the slot stays")
	g.h.TurnEnded("s-a") // the agent's turn ended while the job runs: still held
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.die(4242)
	g.h.Sweep()
	assert.Empty(t, g.holders(), "the job's process is gone and its call has ended: the slot goes back")
}

func TestAForegroundClaimEndsWithItsCallAndAProcessThatDiesFirstDoesNotFreeItEarly(t *testing.T) {
	g := newHookRig(t)
	g.bgClaim("s-a", "Agent A", "call-1", 11)
	g.die(11) // the process is gone but the call has not ended (a slow PostToolUse): not freed yet
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the call has not ended")
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "both ended: freed at the call's end")
}

func TestACrashedSessionFreesABackgroundClaimWhateverItsProcess(t *testing.T) {
	g := newHookRig(t)
	g.bgClaim("s-a", "Agent A", "call-1", 77)
	g.h.After("s-a", "call-1")
	g.h.SessionEnded("s-a") // the agent is gone: its jobs are not a reason to keep the slot
	assert.Empty(t, g.holders())
}
