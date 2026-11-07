package resources

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/proctree"
	"github.com/subgentic/coral/pkg/resourcequeue"
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

// Security's check: a shell named by a claim is believed only below the agent. A process OUTSIDE the agent's tree that keeps running (and starts work) past the call's end cannot keep the slot.
func TestABusyProcessOutsideTheAgentsTreeCannotKeepTheSlotPastTheCallsEnd(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "sh"},
		proctree.Proc{PID: 900, PPID: 1, Command: "someone else's shell"})
	g.bgClaim("s-a", "Agent A", "call-1", 900)                          // names a shell that is not the agent's
	g.addProc(proctree.Proc{PID: 901, PPID: 900, Command: "busy work"}) // it starts work and keeps running
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "the call ended and the shell is not below the agent: freed, however busy that process is")
	g.h.Sweep()
	assert.Empty(t, g.holders())
	// the same claim naming the agent's own shell, with work under it, does hold: only the tree check differs
	g.bgClaim("s-b", "Agent B", "call-2", 500)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "go test ./..."})
	g.h.After("s-b", "call-2")
	assert.Equal(t, []string{"Agent B"}, g.holders(), "the control: below the agent, the work holds it")
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

// #13732 (QA Engineer's real Codex run, stub model): a Codex command that outlives its yield never reports its PostToolUse, so the hook counted the call as running for ever and renewed the lease to the cap. The end of the turn
// (the Stop event) ends every call of the session: the slot goes back then if the work the call started is gone, and when that work is gone if it is not.
func TestAnAutoClaimWhoseCallNeverReportedItsEndIsGivenBackWhenTheTurnEnds(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.add(10 * time.Minute) // the call never said it ended: still "running", the lease renewed
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.TurnEnded("s-a") // the turn is over, and the work is gone
	assert.Empty(t, g.holders(), "a call cannot outlive its turn: no work runs, the slot goes back")
}

func TestAnAutoClaimWhoseWorkOutlivesTheTurnHoldsUntilTheWorkIsGone(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	g.mu.Lock()
	g.procs["s-a"] = []string{"go test ./..."} // the suite keeps running after the turn
	g.mu.Unlock()
	g.h.TurnEnded("s-a")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the work still runs: the slot stays")
	g.add(time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.mu.Lock()
	g.procs["s-a"] = nil
	g.mu.Unlock()
	g.add(time.Minute) // the sweep
	assert.Empty(t, g.holders(), "the work is gone: back")
}

// #13743: a renewal can never carry a claim past its first lease without the work still running. A call that never reported its end counts as running only within the first lease; after it, matching work must be seen.
func TestACallThatNeverEndedCannotRenewTheClaimPastItsFirstLeaseWithoutWork(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy)) // MaxLease 30 min in the rig
	for i := 0; i < 4; i++ {                                                    // the sweep runs every few seconds in the server: minutes in steps keep the lease renewed
		g.add(5 * time.Minute)
	}
	assert.Equal(t, []string{"Agent A"}, g.holders(), "within its first lease the open call holds it")
	for i := 0; i < 3; i++ {
		g.add(5 * time.Minute) // past the first lease, no matching work anywhere
	}
	assert.Empty(t, g.holders(), "past the first lease with no work seen it is not renewed any more")
}

func TestMatchingWorkStillKeepsAClaimPastItsFirstLeaseUntilTheCap(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	g.mu.Lock()
	g.procs["s-a"] = []string{"go test ./..."}
	g.mu.Unlock()
	for i := 0; i < 9; i++ {
		g.add(5 * time.Minute) // 45 minutes
	}
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the suite runs: the claim is renewed past the first lease")
	for i := 0; i < 8; i++ {
		g.add(5 * time.Minute) // past twice the lease: the cap
	}
	assert.Empty(t, g.holders(), "the cap still ends it")
}

// #13773, QA Reviewer 2's SHOULD on #13743: a claim inside its first lease whose call is open does not read the process list (ps is never run for it); past the first lease it must be read, because only the work it started can keep the claim.
func TestAnOpenCallInsideItsFirstLeaseNeverReadsTheProcessList(t *testing.T) {
	g := newHookRig(t)
	reads := 0
	g.h.o.Commands = func(string) []string { g.mu.Lock(); defer g.mu.Unlock(); reads++; return []string{"go test ./..."} }
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy)) // MaxLease 30 min in the rig
	for i := 0; i < 5; i++ {
		g.add(5 * time.Minute) // 25 minutes: inside the first lease, the call open
		g.h.Sweep()
	}
	g.mu.Lock()
	inside := reads
	g.mu.Unlock()
	assert.Equal(t, 0, inside, "inside the first lease, with its call open, the process list is not read")
	g.add(10 * time.Minute) // 35 minutes: past the first lease
	g.h.Sweep()
	g.mu.Lock()
	past := reads
	g.mu.Unlock()
	assert.Greater(t, past, 0, "past it the list is read: only matching work keeps the claim")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "and the matching work it shows keeps it")
}

// goal #227, Frontend Dev's report: the hook told an agent to run `coral-board resource claim mac-heavy --wait` alone and then the command again, but a hand claim goes back when its own tool call ends, so
// the next command was held again, and a command that began with its own claim was refused before the claim could run.
func TestTheStandaloneClaimTheRefusalAsksForKeepsTheSlotForTheNextCommand(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a") // A holds
	assert.NotEmpty(t, g.h.Before(context.Background(), "s-b", "s-b", "call-b1", "go test ./..."), "B is held in line")
	g.h.After("s-a", "call-a")               // A is done: the slot comes to B
	g.handClaim("s-b", "Agent B", "call-b2") // B follows the advice: claim --wait alone, in a call of its own
	g.h.After("s-b", "call-b2")
	assert.Equal(t, []string{"Agent B"}, g.holders(), "the claim that was the answer to the refusal is not undone when its call ends: the command is about to come")
	assert.Equal(t, "", g.h.Before(context.Background(), "s-b", "s-b", "call-b3", "go test ./..."), "and the command runs")
	g.h.After("s-b", "call-b3")
	assert.Empty(t, g.holders(), "that call ended: the slot goes back")
	// nobody comes with the command: the slot passes on after the claim window
	g.handClaim("s-a", "Agent A", "call-a2")
	assert.NotEmpty(t, g.h.Before(context.Background(), "s-b", "s-b", "call-b4", "go test ./..."))
	g.h.After("s-a", "call-a2")
	g.handClaim("s-b", "Agent B", "call-b5")
	g.h.After("s-b", "call-b5")
	g.add(3 * time.Minute)
	assert.Empty(t, g.holders(), "an agent that never comes back does not hold the line")
}

func TestACommandThatBeginsWithItsOwnWaitingClaimIsNotRefusedBeforeTheClaimRuns(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a") // A holds
	ctx := context.Background()
	for _, ok := range []string{
		"coral-board resource claim mac-heavy --wait && go test ./...",
		"coral-board resource claim mac-heavy --wait --timeout 20m && cd coral-go && go test -count=1 ./... 2>&1 | tail",
		"cd x && coral-board resource claim mac-heavy --wait; go test ./...",
	} {
		assert.Equal(t, "", g.h.Before(ctx, "s-b", "s-b", "call-ok", ok), ok)
	}
	for _, held := range []string{
		"coral-board resource claim mac-heavy && go test ./...",             // does not wait: the test would run without the slot
		"coral-board resource claim mini --wait && go test ./...",           // another resource
		`echo "coral-board resource claim mac-heavy --wait"; go test ./...`, // text, not a command
		"go test ./... && coral-board resource claim mac-heavy --wait",      // the claim comes after the work
	} {
		assert.NotEmpty(t, g.h.Before(ctx, "s-b", "s-b", "call-held", held), held)
	}
}

// #13951: the Hub Lead's 2 h pre-run kept running after its claim's lease lapsed, and the queue showed the mini free with the run still going. A claim whose work is alive is renewed (up to the heavy-run cap); one whose
// work is gone, or that has no shell to look at, is left to its lease.
func TestAClaimWhoseWorkStillRunsIsKeptPastItsLease(t *testing.T) {
	g := newHookRig(t) // mac-heavy: one slot, a 30 minute lease
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash -c claim; ssh mini run"},
		proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "ssh mini run"}) // the work the call started, still going
	for i := 0; i < 6; i++ {                                               // 6 x 20 minutes: two hours, past the 30 minute lease and inside the 150 minute cap
		g.add(20 * time.Minute)
	}
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the work runs: the slot is still held, not shown free")
	g.dropProc(502)
	g.h.After("s-a", "call-1")
	g.h.Sweep()
	assert.Empty(t, g.holders(), "the work is gone and the call ended: back")
}

func TestAClaimWithNoWorkOrNoShellIsLeftToItsLease(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-1") // no shell known: nothing to look at
	g.add(31 * time.Minute)
	assert.Empty(t, g.holders(), "the lease ended it, as before")

	g2 := newHookRig(t)
	g2.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "sh"})
	g2.bgClaim("s-a", "Agent A", "call-1", 500) // a shell with nothing started under it
	g2.add(31 * time.Minute)
	assert.Empty(t, g2.holders(), "no work alive: the lease ends it")
}

func TestARenewedClaimStopsAtTheHeavyRunCap(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash"},
		proctree.Proc{PID: 502, PPID: 500, Command: "server run", CPU: 40})
	_, err := g.m.Claim(context.Background(), "mac-heavy", "Agent A", "bg")
	require.NoError(t, err)
	g.dropProc(502) // not there at the claim, so it is the work the call started
	g.h.BindHand("s-a", "Agent A", "mac-heavy", []string{"call-1"}, 500, agentPID)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "server run", CPU: 40})
	for i := 0; i < 7; i++ {
		g.add(20 * time.Minute) // 140 minutes: inside the cap, still held
	}
	assert.Equal(t, []string{"Agent A"}, g.holders())
	for i := 0; i < 3; i++ {
		g.add(20 * time.Minute) // 200 minutes: the last renewal was inside the cap, its lease has run out since
	}
	assert.Empty(t, g.holders(), "a process that never ends does not hold the slot for ever")
}

// QA's two pins on #13951. The realistic end: the work is gone while the call has not reported its end (a crashed ssh, a killed job): the renewals stop and the lease ends the claim.
func TestAClaimStopsBeingRenewedWhenItsWorkEndsBeforeItsCallDoes(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash -c claim; ssh mini run"},
		proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "ssh mini run"})
	for i := 0; i < 5; i++ {
		g.add(20 * time.Minute) // 100 minutes of work: renewed the whole time
	}
	require.Equal(t, []string{"Agent A"}, g.holders())
	g.dropProc(502) // the work ends; the tool call never says so
	g.add(20 * time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders(), "still inside the last renewal's lease")
	g.add(20 * time.Minute) // past the lease with no renewal in between
	assert.Empty(t, g.holders(), "the work is gone: nothing renews it, and the lease ends the claim")
}

// Only the claiming agent's own claim is renewed: another agent's claim on the same resource, whose own work is gone, is not kept by this agent's work.
func TestOnlyTheClaimingAgentsClaimIsRenewedByItsWork(t *testing.T) {
	g := newHookRig(t)
	require.NoError(t, g.m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 2, MaxLease: 30 * time.Minute, Match: []string{"go test ./...", "node run_cdp_suites.mjs"}}))
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "claude"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash -c claim; go test ./..."},
		proctree.Proc{PID: 600, PPID: agentPID, Command: "bash -c claim; sleep 1"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.bgClaim("s-b", "Agent B", "call-2", 600)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "go test ./..."}) // A's work only; nothing started under B's shell
	for i := 0; i < 4; i++ {
		g.add(20 * time.Minute)
	}
	assert.Equal(t, []string{"Agent A"}, g.holders(), "A's work keeps A's slot; B, with no work of its own, is left to its lease and went")
}

// #14026: a Codex agent's shell is a wrapper: the command the hook sees is `bash -lc "<what the agent typed>"` (or zsh -lc, /bin/bash -c). The combined form `claim --wait && <work>` must be let through there as it is bare,
// and the work behind a claim that does not wait, or after the work, is still held.
func TestACombinedWaitingClaimIsLetThroughInsideAShellWrapper(t *testing.T) {
	g := newHookRig(t)
	g.handClaim("s-a", "Agent A", "call-a") // A holds the only slot
	ctx := context.Background()
	inner := "coral-board resource claim mac-heavy --wait && cd coral-go && go test ./..."
	for _, wrap := range []string{
		"%s",
		"bash -lc '%s'",
		`bash -lc "%s"`,
		`zsh -lc "%s"`,
		"/bin/bash -c '%s'",
		`sh -c "%s"`,
		"env FOO=1 bash -lc '%s'",
		"timeout 7200 bash -lc '%s'",
	} {
		cmd := fmt.Sprintf(wrap, inner)
		assert.Equal(t, "", g.h.Before(ctx, "s-b", "s-b", "call-"+wrap, cmd), "let through: "+cmd)
	}
	for _, held := range []string{
		`bash -lc "coral-board resource claim mac-heavy && go test ./..."`,
		`bash -lc "go test ./... && coral-board resource claim mac-heavy --wait"`,
		`zsh -lc "coral-board resource claim mini --wait && go test ./..."`,
		`bash -lc 'echo "coral-board resource claim mac-heavy --wait"; go test ./...'`,
	} {
		assert.NotEmpty(t, g.h.Before(ctx, "s-b", "s-b", "call-held", held), "still held: "+held)
	}
}

// #14079 (the Operator: "agents are holding the resource queue beyond the time they need it"): a hold is kept only while something real runs under it.
func idleRig(t *testing.T, work proctree.Proc) (*hookRig, *[]string) {
	g := newHookRig(t)
	var told []string
	g.h.o.Notify = func(agent, text string) { told = append(told, agent+": "+text) }
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "codex"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash"},
		proctree.Proc{PID: 501, PPID: 500, Command: "coral-board resource claim mac-heavy --wait"})
	g.bgClaim("s-a", "Agent A", "call-1", 500)
	g.dropProc(501)
	g.addProc(work)
	return g, &told
}

func TestAHolderWhoseShellOnlyWaitsLosesTheSlotAfterTheGraceAndTheBoardIsTold(t *testing.T) {
	for _, cmd := range []string{"sleep 600", "tail -f /tmp/x.log", "coral-board resource claim mac-heavy --wait", "bash -lc sleep"} {
		g, told := idleRig(t, proctree.Proc{PID: 502, PPID: 500, Command: cmd, CPU: 0})
		g.add(15 * time.Second) // the first look: idle since now
		idle, ok := g.h.IdleFor("mac-heavy", "Agent A")
		assert.True(t, ok, cmd)
		assert.Zero(t, idle, cmd)
		g.add(2 * time.Minute)
		assert.Equal(t, []string{"Agent A"}, g.holders(), cmd+": inside the grace")
		g.add(time.Minute + time.Second) // 3 minutes idle
		assert.Empty(t, g.holders(), cmd+": the slot is taken back")
		require.NotEmpty(t, g.events, cmd)
		assert.Equal(t, "idle", g.events[len(g.events)-1].Why, cmd+": the record says why")
		require.Len(t, *told, 1, cmd)
		assert.Contains(t, (*told)[0], "Agent A")
		assert.Contains(t, (*told)[0], "3 minutes")
	}
}

func TestAHolderWhoseProcessUsesCpuOrIsATestRunnerKeepsTheSlotPastTheLease(t *testing.T) {
	for name, w := range map[string]proctree.Proc{
		"busy":        {PID: 502, PPID: 500, Command: "some-tool --flag", CPU: 55},
		"test runner": {PID: 502, PPID: 500, Command: "node run_cdp_suites.mjs --only x", CPU: 0}, // waiting on a browser
		"go test":     {PID: 502, PPID: 500, Command: "/usr/local/go/bin/go test ./internal/server", CPU: 0},
		"remote run":  {PID: 502, PPID: 500, Command: "ssh mini coral-test", CPU: 0},
	} {
		g, told := idleRig(t, w)
		for i := 0; i < 4; i++ {
			g.add(20 * time.Minute) // past the 30 minute lease, inside the cap
		}
		assert.Equal(t, []string{"Agent A"}, g.holders(), name)
		_, idle := g.h.IdleFor("mac-heavy", "Agent A")
		assert.False(t, idle, name+": working is not idle")
		assert.Empty(t, *told, name)
	}
}

func TestAHolderWhoStartsWorkingAgainIsNotIdleAnyMore(t *testing.T) {
	g, told := idleRig(t, proctree.Proc{PID: 502, PPID: 500, Command: "sleep 600"})
	g.add(15 * time.Second)
	g.add(2 * time.Minute)
	_, idle := g.h.IdleFor("mac-heavy", "Agent A")
	assert.True(t, idle)
	g.dropProc(502)
	g.addProc(proctree.Proc{PID: 503, PPID: 500, Command: "go test ./...", CPU: 90})
	g.add(2 * time.Minute)
	_, idle = g.h.IdleFor("mac-heavy", "Agent A")
	assert.False(t, idle, "the clock starts again")
	g.add(10 * time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders())
	assert.Empty(t, *told)
}

// #14079: a claim made with no tool call known (the common case: calls_known=0) is still judged by the work under its believed shell.
func TestAHolderWithNoKnownCallIsJudgedByItsShellToo(t *testing.T) {
	g := newHookRig(t)
	g.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "codex"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash"})
	_, err := g.m.Claim(context.Background(), "mac-heavy", "Agent A", "bg")
	require.NoError(t, err)
	g.h.BindHand("s-a", "Agent A", "mac-heavy", nil, 500, agentPID)
	g.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "sleep 600"})
	g.add(15 * time.Second)
	g.add(3*time.Minute + time.Second)
	assert.Empty(t, g.holders(), "idle with no known call: taken back")

	g2 := newHookRig(t)
	g2.setProcs(proctree.Proc{PID: agentPID, PPID: 1, Command: "codex"}, proctree.Proc{PID: 500, PPID: agentPID, Command: "bash"})
	_, err = g2.m.Claim(context.Background(), "mac-heavy", "Agent A", "bg")
	require.NoError(t, err)
	g2.h.BindHand("s-a", "Agent A", "mac-heavy", nil, 500, agentPID)
	g2.addProc(proctree.Proc{PID: 502, PPID: 500, Command: "go test ./...", CPU: 80})
	for i := 0; i < 4; i++ {
		g2.add(20 * time.Minute)
	}
	assert.Equal(t, []string{"Agent A"}, g2.holders(), "working with no known call: kept past the lease")
	g2.h.TurnEnded("s-a")
	g2.dropProc(502)
	g2.h.Sweep()
	assert.Empty(t, g2.holders(), "the turn ended and the work is gone: back")
}

// #14222: a slot the hook gives back (its call ended, its session ended) leaves ONE end event with the reason in the queue's record. Before, it went through Leave, which told nobody: 200 of 918 holds in one record
// had no end at all.
func TestAHandClaimGivenBackByTheHookLeavesAnEndEventWithItsReason(t *testing.T) {
	hist := filepath.Join(t.TempDir(), "resource_history.db")
	g := newHookRig(t, func(o *Options) { o.HistoryPath = hist })
	g.handClaim("s-a", "Agent A", "call-1")
	g.h.After("s-a", "call-1") // the call ended: the hook gives the slot back
	g.handClaim("s-b", "Agent B", "call-9")
	g.h.SessionEnded("s-b") // the session ended
	g.m.History().Flush()
	evs, err := g.m.History().Events(g.now.Add(-time.Hour), g.now.Add(time.Hour))
	require.NoError(t, err)
	var ends []string
	for _, e := range evs {
		if e.Kind == "released" || e.Kind == "gone" || e.Kind == "expired" || e.Kind == "kicked" {
			ends = append(ends, e.Agent+":"+e.Kind+":"+e.Why)
		}
	}
	assert.Contains(t, ends, "Agent A:released:call ended")
	require.Len(t, ends, 2, "one end event for each hold: %v", ends)
}
