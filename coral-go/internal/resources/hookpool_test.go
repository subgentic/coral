package resources

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #13751: the shell hook with a pool. A command that matches the pool claims it: a Mac grant runs as before; a grant on the mini is not run here, the agent is told to run the same command with coral-board heavy run and keeps
// its slot for a moment; a pattern kept on a plain resource (mac-heavy) is for the Mac only and never goes to the mini.

func poolRig(t *testing.T) *hookRig {
	t.Helper()
	g := newHookRig(t)
	q := g.m.Queue()
	require.NoError(t, q.Remove("mac-heavy"))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Machine: "Mac", MaxLease: 30 * time.Minute, Match: []string{"node run_cdp_suites.mjs"}})) // the Mac-only patterns live on the Mac's own resource
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "mini", Slots: 1, Machine: "Mini", MaxLease: 10 * time.Minute}))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "heavy", Members: []string{"mac-heavy", "mini"}, Match: []string{"go test ./..."}}))
	g.agents["s-d"] = "Agent D"
	return g
}

func holdersOf(g *hookRig, key string) []string {
	st, _ := g.m.Queue().Status(key)
	var out []string
	for _, e := range st.Holders {
		out = append(out, e.Agent+"@"+e.Member)
	}
	return out
}

func TestAMatchOnThePoolGrantedTheMacRunsAsBefore(t *testing.T) {
	g := poolRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy), "a Mac grant runs here")
	assert.Equal(t, []string{"Agent A@mac-heavy"}, holdersOf(g, "heavy"))
	g.h.After("s-a", "call-1")
	assert.Empty(t, holdersOf(g, "heavy"), "and goes back when the call ends")
}

func TestAMatchOnThePoolGrantedTheMiniIsNotRunHereAndTheAgentIsToldHowAndKeepsTheSlotAMoment(t *testing.T) {
	g := poolRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy)) // A takes the Mac
	msg := g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy)                // B is granted the mini
	assert.Contains(t, msg, "coral-board heavy run --", "the way to run it there")
	assert.Contains(t, msg, "Mini", "and where")
	assert.NotContains(t, msg, "hunter2-secret", "the command is never repeated")
	assert.Contains(t, holdersOf(g, "heavy"), "Agent B@mini", "B's slot on the mini is kept for the follow-up")
	assert.Equal(t, "redirected", g.events[len(g.events)-1].Kind)
	// asked again before the follow-up: the same answer, no second slot
	again := g.h.Before(t.Context(), "s-b", "s-b", "call-3", heavy)
	assert.Contains(t, again, "coral-board heavy run --")
	assert.Len(t, holdersOf(g, "heavy"), 2)
	// the agent does nothing with it: after the claim window the slot passes on
	g.add(3 * time.Minute)
	assert.NotContains(t, holdersOf(g, "heavy"), "Agent B@mini", "an unused slot is not kept for ever")
}

func TestTheFollowUpHeavyRunIsTheSameHoldAndEndsWithItsCall(t *testing.T) {
	g := poolRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	require.Contains(t, g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy), "heavy run")
	// B runs the same command through heavy run: the hook sees a Bash call that is not itself a heavy command, and ties it to B's slot
	assert.Equal(t, "", g.h.Before(t.Context(), "s-b", "s-b", "call-4", "coral-board heavy run -- go test -count=1 ./..."))
	g.add(5 * time.Minute) // longer than the claim window: the call is running, so the slot stays
	assert.Contains(t, holdersOf(g, "heavy"), "Agent B@mini")
	g.h.After("s-b", "call-4")
	assert.NotContains(t, holdersOf(g, "heavy"), "Agent B@mini", "the call ended: the slot goes back")
}

func TestAPatternOnTheMacsOwnResourceNeverGoesToTheMini(t *testing.T) {
	g := poolRig(t)
	const cdp = "cd tests/frontend && node run_cdp_suites.mjs --only x"
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", cdp), "the Mac is free: it runs")
	msg := g.h.Before(t.Context(), "s-b", "s-b", "call-2", cdp)
	assert.Contains(t, msg, "mac-heavy is busy", "the Mac is full: it waits for the Mac")
	assert.NotContains(t, msg, "heavy run --", "and is never sent to the mini")
	assert.Empty(t, holdersOf(g, "mini"), "though the mini is free")
}

func TestAPlainResourcesPatternWinsOverAPoolsWhenBothMatch(t *testing.T) {
	g := poolRig(t)
	require.NoError(t, g.m.Queue().Define(resourcequeue.Resource{Key: "heavy", Members: []string{"mac-heavy", "mini"}, Match: []string{"go test ./...", "node run_cdp_suites.mjs"}}))
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", "node run_cdp_suites.mjs"))
	assert.Equal(t, []string{"Agent A@"}, holdersOf(g, "mac-heavy"), "claimed on mac-heavy itself, not the pool")
	assert.Empty(t, holdersOf(g, "heavy"), "the pool itself holds nothing")
}

func TestAWaitingPoolEntryLaterGrantedTheMiniIsRedirectedWhenItRetries(t *testing.T) {
	g := poolRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))             // Mac
	require.Contains(t, g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy), "heavy run") // mini
	refused := g.h.Before(t.Context(), "s-c", "s-c", "call-3", heavy)                        // C waits: both slots are taken
	require.Contains(t, refused, "number 1 in line")
	g.add(3 * time.Minute) // B never used its redirected slot: after the claim window it passes to the first in the pool's line
	assert.Contains(t, holdersOf(g, "heavy"), "Agent C@mini", "the mini's slot went to the first in the pool's line")
	retry := g.h.Before(t.Context(), "s-c", "s-c", "call-5", heavy)
	assert.Contains(t, retry, "coral-board heavy run --", "C's retry on a slot that is the mini's is redirected, not run here")
	assert.False(t, strings.Contains(retry, "number"), "it is not told it is in line")
}

var _ = context.Background

// QA Reviewer 2's pins on #13751.

// The mini is told by its machine as well as by its member's name: a member called something else whose machine is Mini is still the mini.
func TestAMemberNamedOtherwiseWhoseMachineIsMiniIsStillRedirected(t *testing.T) {
	g := newHookRig(t)
	q := g.m.Queue()
	require.NoError(t, q.Remove("mac-heavy"))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "studio", Slots: 1, Machine: "Mac", MaxLease: 30 * time.Minute}))
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "box2", Slots: 1, Machine: "Mini", MaxLease: 30 * time.Minute})) // named otherwise, machine Mini
	require.NoError(t, q.Define(resourcequeue.Resource{Key: "heavy", Members: []string{"studio", "box2"}, Match: []string{"go test ./..."}}))
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy), "the first member is a Mac: it runs")
	msg := g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy)
	assert.Contains(t, msg, "coral-board heavy run --", "granted box2 whose machine is Mini: not run here")
	assert.Contains(t, msg, "Mini")
	// and the reverse: a member named mini whose machine says Mac is the mini by its name (the CLI's rule is the same)
	g2 := newHookRig(t)
	q2 := g2.m.Queue()
	require.NoError(t, q2.Remove("mac-heavy"))
	require.NoError(t, q2.Define(resourcequeue.Resource{Key: "one", Slots: 1, Machine: "Mac", MaxLease: 30 * time.Minute}))
	require.NoError(t, q2.Define(resourcequeue.Resource{Key: "mini", Slots: 1, Machine: "Mac", MaxLease: 30 * time.Minute}))
	require.NoError(t, q2.Define(resourcequeue.Resource{Key: "heavy", Members: []string{"one", "mini"}, Match: []string{"go test ./..."}}))
	require.Equal(t, "", g2.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	assert.Contains(t, g2.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy), "coral-board heavy run --")
}

// Once the follow-up heavy run has started, the sweep never frees the slot, however far the clock goes past the claim window, while the call is running; and each sweep keeps the lease renewed.
func TestTheSweepNeverFreesAFollowUpsSlotWhileItsCallRunsHoweverLongAfterTheWindow(t *testing.T) {
	g := poolRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	require.Contains(t, g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy), "heavy run")
	require.Equal(t, "", g.h.Before(t.Context(), "s-b", "s-b", "call-4", "coral-board heavy run -- go test ./..."))
	for i := 0; i < 12; i++ { // an hour in five-minute steps: far past the two-minute window and past the mini's ten-minute lease
		g.add(5 * time.Minute)
		g.h.Sweep()
		require.Contains(t, holdersOf(g, "heavy"), "Agent B@mini", "step %d: the follow-up is running: the slot is its own", i)
	}
	st, _ := g.m.Queue().Status("heavy")
	for _, e := range st.Holders {
		if e.Agent == "Agent B" {
			assert.True(t, e.Lease.After(g.clock()), "the sweep kept the lease renewed")
		}
	}
	g.h.After("s-b", "call-4")
	assert.NotContains(t, holdersOf(g, "heavy"), "Agent B@mini", "and the call's end frees it")
}

// A heavy run may last as long as the wrapper allows (2 h), so its hold is kept that long whatever the lease, and not for ever when the call never ends.
func TestAHeavyRunHoldIsKeptUpToTheWrappersCapAndNotBeyondIt(t *testing.T) {
	g := poolRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	require.Contains(t, g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy), "heavy run")
	require.Equal(t, "", g.h.Before(t.Context(), "s-b", "s-b", "call-4", "coral-board heavy run -- go test ./..."))
	for i := 0; i < 24; i++ { // two hours
		g.add(5 * time.Minute)
		g.h.Sweep()
	}
	assert.Contains(t, holdersOf(g, "heavy"), "Agent B@mini", "two hours in: still the run's (the wrapper's own cap is two hours)")
	for i := 0; i < 8; i++ { // three hours
		g.add(5 * time.Minute)
		g.h.Sweep()
	}
	assert.NotContains(t, holdersOf(g, "heavy"), "Agent B@mini", "a call that never ends is not kept for ever")
}
