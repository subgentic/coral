package resources

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/proctree"
)

// #13718, the Operator's design: a slot an agent claims by hand belongs to the tool call it was claimed in, and Coral gives it back when that call ends (or the agent's turn or session does): a forgotten release cannot hold the line.

func (g *hookRig) handClaim(session, agent, call string) {
	g.t.Helper()
	res, err := g.m.Claim(context.Background(), "mac-heavy", agent, "by hand")
	require.NoError(g.t, err)
	_ = res
	g.h.BindHand(session, agent, "mac-heavy", []string{call}, 0, 0)
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

func TestAWaitingHandClaimKeepsItsPlaceForAGraceWhenItsCallEnds(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a")
	g.handClaim("s-b", "Agent B", "call-b") // waits
	require.Len(t, g.queue(), 1)
	g.h.After("s-b", "call-b") // its --wait ended (timeout, cancel): #13706, the place is kept for a grace, not dropped
	require.Len(t, g.queue(), 1, "the place is still in line")
	assert.Equal(t, "Agent B", g.queue()[0].Agent)
	assert.False(t, g.queue()[0].Away.IsZero(), "and marked as kept for an agent that is away")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the holder is untouched")
	g.h.After("s-a", "call-a")
	assert.Empty(t, g.holders(), "a slot that comes while B is away is not held for B: nobody here is waiting, so it stays free")
	require.Len(t, g.queue(), 1, "and B's place is still there")
	g.handClaim("s-b", "Agent B", "call-b2") // B is back
	assert.Equal(t, []string{"Agent B"}, g.holders(), "back, B has the free slot at once")
}

func TestAWaitingHandClaimOfASessionThatEndedLeavesTheLineAtOnce(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a")
	g.handClaim("s-b", "Agent B", "call-b") // waits
	g.h.SessionEnded("s-b")
	assert.Empty(t, g.queue(), "a gone agent keeps no place")
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

// A job run in the background outlives its tool call (Claude's run_in_background, Codex's background terminal): the claim also follows the work the call started under the claiming shell, and goes back when the call has ended
// AND that work is gone. The shell itself may be a persistent one (a Codex terminal): only what started after the claim counts. The pid is believed only when it is in the agent's own process tree.
const agentPID = 100

func (g *hookRig) setProcs(ps ...proctree.Proc) { g.mu.Lock(); g.plist = ps; g.mu.Unlock() }
func (g *hookRig) addProc(p proctree.Proc)      { g.mu.Lock(); g.plist = append(g.plist, p); g.mu.Unlock() }
func (g *hookRig) dropProc(pid int) {
	g.mu.Lock()
	var keep []proctree.Proc
	for _, p := range g.plist {
		if p.PID != pid {
			keep = append(keep, p)
		}
	}
	g.plist = keep
	g.mu.Unlock()
}

// bgClaim: a claim run by coral-board (pid cli) whose parent is the shell `shell`, a child of the agent.
func (g *hookRig) bgClaim(session, agent, call string, shell int) {
	g.t.Helper()
	_, err := g.m.Claim(context.Background(), "mac-heavy", agent, "bg")
	require.NoError(g.t, err)
	g.h.BindHand(session, agent, "mac-heavy", []string{call}, shell, agentPID)
}

func TestAForegroundClaimIsGivenBackAtTheEndOfItsCallEvenInAShellThatKeepsRunning(t *testing.T) {
	g := newHookRig(t)
	// a persistent shell (a Codex terminal) with an older background job that is still running, and the claim's own command
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "codex"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash"},
		proctree.Proc{PID: 480, PPID: 500, Command: "go test ./... (older job)"}, proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501) // the claim command returned: nothing new started under the shell
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "the shell and its older job go on, but nothing this call started does: freed at the call's end")
}

func TestABackgroundJobKeepsTheSlotAfterItsCallUntilTheWorkItStartedIsGone(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash -c claim; go test ./..."},
		proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "go test ./..."}) // the work the call started
	g.h.After("s-a", "call-1")
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the work still runs: the slot stays")
	g.h.TurnEnded("s-a") // the agent's turn ended while the job runs: still held
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.dropProc(502)
	g.h.Sweep()
	assert.Empty(t, g.holders(), "the work is gone and the call has ended: back")
}

func TestAShellThatBecameTheJobItselfKeepsTheSlotWhileItRuns(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "sh -c claim && go test ./..."},
		proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501)
	g.dropProc(500)
	g.addProc(proctree.Proc{PID: 500, PPID: agentPID, Command: "go test ./..."}) // the shell exec'd the last command: same pid, new program
	g.h.After("s-a", "call-1")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the pid is now the job")
	g.dropProc(500)
	g.h.Sweep()
	assert.Empty(t, g.holders())
}

func TestADeadProcessDoesNotFreeAClaimWhoseCallHasNotEnded(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "sh"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(500)
	g.h.Sweep()
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the call has not ended")
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders())
}

func TestAPidOutsideTheAgentsProcessTreeIsNotBelievedAndACrashedSessionFreesEverything(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 900, PPID: 1, Command: "somebody else's daemon"})
	g.bgClaim("s-a", "Agent A", "call-1", 900) // named, but not below the agent: the claim follows its call alone
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "a pid the agent does not own cannot keep a slot")
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "sh"})
	g.bgClaim("s-b", "Agent B", "call-2", 500)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "go test ./..."})
	g.h.After("s-b", "call-2")
	g.h.SessionEnded("s-b") // the agent is gone: its jobs are not a reason to keep the slot
	assert.Empty(t, g.holders())
}

// Tools run in parallel, and a client cannot say which of the calls in flight is its own: the claim is tied to all of them and goes back when the LAST has ended, so a sibling that ends first cannot free it (it only holds a little longer).
func TestAClaimMadeAmongParallelCallsWaitsForAllOfThem(t *testing.T) {
	g := newHookRig(t)
	_, err := g.m.Claim(context.Background(), "mac-heavy", "Agent A", "")
	require.NoError(t, err)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{"call-1", "call-2"}, 0, 0) // the claim is in call-1 or call-2
	g.h.After("s-a", "call-2")                                                      // the other call ends first
	assert.Equal(t, []string{"Agent A"}, g.holders(), "it may be call-1's: not freed yet")
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "every call it could belong to has ended")
}

func TestAClaimWithNoKnownCallOrAnEmptyIdIsNeverBound(t *testing.T) {
	g := newHookRig(t)
	_, err := g.m.Claim(context.Background(), "mac-heavy", "Agent A", "")
	require.NoError(t, err)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", nil, 0, 0)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{""}, 0, 0) // an empty id (a hook that sent none) must not match an After with an empty id
	g.h.After("s-a", "")
	g.h.TurnEnded("s-b")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "no call to tie it to: its lease alone ends it")
}

// #13706, the Orchestrator's second case: a wait that ended (its tool call over) and the agent's held command run again must be the SAME place, not the back of the line.
func TestAKeptPlaceIsTheSamePlaceWhenTheHeldCommandIsRunAgain(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a")
	g.handClaim("s-b", "Agent B", "call-b") // waits at 1
	g.handClaim("s-c", "Agent C", "call-c") // waits at 2
	g.h.After("s-b", "call-b")              // B's wait ended
	msg := g.h.Before(t.Context(), "s-b", "s-b", "call-b2", heavy)
	assert.Contains(t, msg, "number 1 in line", "B is still first, not behind C")
	q := g.queue()
	require.Len(t, q, 2)
	assert.Equal(t, "Agent B", q[0].Agent)
	assert.True(t, q[0].Away.IsZero(), "and it is present again: no grace runs on it")
}
