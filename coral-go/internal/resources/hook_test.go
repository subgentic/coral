package resources

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/pkg/resourcequeue"
)

// #13645: the shell hook. A fake clock, a fake "who is this session" and a fake list of running processes: no real command is run.

type hookRig struct {
	t      *testing.T
	m      *Manager
	h      *Hook
	mu     sync.Mutex
	now    time.Time
	agents map[string]string // session -> member
	procs  map[string][]string
	events []HookEvent
}

func newHookRig(t *testing.T) *hookRig {
	t.Helper()
	g := &hookRig{t: t, now: time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC), agents: map[string]string{"s-a": "Agent A", "s-b": "Agent B", "s-c": "Agent C"}, procs: map[string][]string{}}
	m, err := Open(Options{Now: g.clock, AgeStep: -1})
	require.NoError(t, err)
	g.m = m
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, MaxLease: 30 * time.Minute, Match: []string{"go test ./...", "node run_cdp_suites.mjs"}}))
	g.h = NewHook(m, HookOptions{
		Now: g.clock,
		Agent: func(_ context.Context, s string) (string, bool) {
			a, ok := g.agents[s]
			return a, ok
		},
		Commands: func(s string) []string { g.mu.Lock(); defer g.mu.Unlock(); return g.procs[s] },
		Event:    func(e HookEvent) { g.events = append(g.events, e) },
	})
	return g
}

func (g *hookRig) clock() time.Time { g.mu.Lock(); defer g.mu.Unlock(); return g.now }
func (g *hookRig) add(d time.Duration) {
	g.mu.Lock()
	g.now = g.now.Add(d)
	g.mu.Unlock()
	_, _ = g.m.Queue().Reap()
	g.h.Sweep()
}

func (g *hookRig) holders() []string {
	st, _ := g.m.Queue().Status("mac-heavy")
	var out []string
	for _, e := range st.Holders {
		out = append(out, e.Agent)
	}
	return out
}

func (g *hookRig) queue() []resourcequeue.Entry {
	st, _ := g.m.Queue().Status("mac-heavy")
	return st.Queue
}

const heavy = "cd coral-go && TOKEN=hunter2-secret go test -count=1 ./... 2>&1 | tail"

func TestAMatchingCallOnAFreeResourceRunsHoldsTheSlotAndGivesItBack(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.h.After("s-a", "call-1")
	assert.Empty(t, g.holders(), "the slot goes back when the call ends")
	require.Len(t, g.events, 2)
	assert.Equal(t, "claimed", g.events[0].Kind)
	assert.Equal(t, "go test ./...", g.events[0].Pattern, "the event carries the manager's pattern")
	assert.Equal(t, "call ended", g.events[1].Why)
}

func TestACommandThatMatchesNothingNeverTouchesTheQueue(t *testing.T) {
	g := newHookRig(t)
	for _, c := range []string{"go build ./...", "go test -run X ./one", `echo "go test ./..."`, "ls"} {
		assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "c", c), c)
	}
	assert.Empty(t, g.holders())
	assert.Empty(t, g.queue())
	assert.Empty(t, g.events)
}

func TestABusyResourceHoldsTheCommandWithItsPlaceAndKeepsThePlaceOnRetry(t *testing.T) {
	g := newHookRig(t)
	_, err := g.m.Claim(t.Context(), "mac-heavy", "Agent B", "explicit")
	require.NoError(t, err)
	msg := g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy)
	assert.Contains(t, msg, "mac-heavy is busy")
	assert.Contains(t, msg, "number 1 in line")
	assert.Contains(t, msg, "coral-board resource claim mac-heavy --wait", "the first thing it says is how to wait")
	assert.Contains(t, msg, "Do not retry in a loop")
	for _, secret := range []string{"hunter2", "TOKEN", "go test", "tail", "coral-go"} {
		assert.NotContains(t, msg, secret, "the refusal never repeats the command")
	}
	q := g.queue()
	require.Len(t, q, 1)
	assert.Equal(t, "auto: go test ./...", q[0].Note, "the queue shows the pattern, never the command")
	assert.NotContains(t, q[0].Note, "hunter2")
	assert.Contains(t, g.h.Before(t.Context(), "s-a", "s-a", "call-2", heavy), "number 1 in line", "the retry keeps its place")
	assert.Len(t, g.queue(), 1, "and does not queue twice")

	require.NoError(t, g.m.Queue().Release("mac-heavy", "Agent B"))
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the slot came up")
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-3", heavy), "the next attempt runs")
	g.h.After("s-a", "call-3")
	assert.Empty(t, g.holders())
}

func TestEverythingThatCanGoWrongLetsTheCommandRun(t *testing.T) {
	g := newHookRig(t)
	g.agents = map[string]string{} // the session is on no board
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "c", heavy))
	assert.Empty(t, g.holders())
	g.agents = map[string]string{"s-a": "Agent A"}
	require.NoError(t, g.m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Match: []string{"go test ./..."}, Allowed: []string{"somebody else"}}))
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "c", heavy), "a claim the queue refuses does not stop the command")
	var none *Hook
	assert.Equal(t, "", none.Before(t.Context(), "s-a", "s-a", "c", heavy), "no hook, no queue: runs")
	none.After("s-a", "c")
	none.SessionEnded("s-a")
	assert.Equal(t, "", NewHook(nil, HookOptions{}).Before(t.Context(), "s-a", "s-a", "c", heavy))
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "c", strings.Repeat("echo x\n", 50000)+"go test ./..."), "a command past the reader's bounds runs")
}

func TestACallThatReturnsWhileItsWorkRunsKeepsTheSlotUntilTheWorkIsGone(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", "nohup go test ./... > out.log 2>&1 &"))
	g.mu.Lock()
	g.procs["s-a"] = []string{"go test ./..."} // the suite is still running under the agent
	g.mu.Unlock()
	g.h.After("s-a", "call-1") // the Bash call itself has returned
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the slot is not freed while the work runs")
	g.add(10 * time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders(), "and its lease is renewed, not lost")
	st, _ := g.m.Queue().Status("mac-heavy")
	assert.True(t, st.Holders[0].Lease.After(g.clock().Add(20*time.Minute)), "renewed to a full lease")
	g.mu.Lock()
	g.procs["s-a"] = nil
	g.mu.Unlock()
	g.add(4 * time.Second) // past the few seconds a process list is reused
	assert.Empty(t, g.holders(), "the work is gone: the slot goes back")
}

func TestAnAutoClaimIsCappedAtTwiceTheLeaseWhateverIsRunning(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy)) // its PostToolUse never comes
	for i := 0; i < 5; i++ {
		g.add(10 * time.Minute) // 50 minutes: still under twice the 30 minute lease
	}
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.add(15 * time.Minute) // past 60 minutes
	assert.Empty(t, g.holders(), "a hook that never heard the call end cannot keep the slot forever")
	assert.Equal(t, "cap", g.events[len(g.events)-1].Why)
}

func TestASlotGrantedToAWaitingAutoClaimPassesOnIfItsAgentRunsNothing(t *testing.T) {
	g := newHookRig(t)
	_, _ = g.m.Claim(t.Context(), "mac-heavy", "Agent C", "explicit")
	assert.NotEqual(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy), "A waits")
	_, _ = g.m.Claim(t.Context(), "mac-heavy", "Agent B", "explicit") // B waits behind A
	require.NoError(t, g.m.Queue().Release("mac-heavy", "Agent C"))
	assert.Equal(t, []string{"Agent A"}, g.holders(), "A's turn came")
	g.add(time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders(), "A has a moment to run the command again")
	g.add(90 * time.Second) // past the two-minute claim window
	assert.Equal(t, []string{"Agent B"}, g.holders(), "A ran nothing: B has the slot")
}

func TestAnExplicitClaimIsNeverTrackedOrReleasedByTheHook(t *testing.T) {
	g := newHookRig(t)
	_, _ = g.m.Claim(t.Context(), "mac-heavy", "Agent A", "explicit")
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	g.h.After("s-a", "call-1")
	g.add(time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders(), "the agent claimed it, so the agent releases it")
	assert.Empty(t, g.events)
}

func TestAnEndedSessionGivesItsAutoClaimBack(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	g.h.SessionEnded("s-a")
	assert.Empty(t, g.holders())
	assert.Equal(t, "gone", g.events[len(g.events)-1].Why)
}

func TestTheHookClaimsForTheSessionsOwnAgentOnly(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	// another agent's end-of-call or session end never frees A's slot
	g.h.After("s-b", "call-1")
	g.h.SessionEnded("s-b")
	assert.Equal(t, []string{"Agent A"}, g.holders())
}

// QA Reviewer 2 / the Orchestrator: this hook is on every agent's Bash call, so reading the process list (ps, up to 3 s) never holds up another agent's call, and with no resource matching nothing is looked up.
func TestASlowProcessListNeverHoldsUpAnotherAgentsCall(t *testing.T) {
	g := newHookRig(t)
	require.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", heavy))
	block, entered := make(chan struct{}), make(chan struct{}, 4)
	g.h.o.Commands = func(string) []string { entered <- struct{}{}; <-block; return nil }
	done := make(chan struct{})
	go func() { g.h.After("s-a", "call-1"); close(done) }() // A's call ended: the hook now asks what A's agent still runs, and that read is slow
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the process list was never read")
	}
	answered := make(chan string, 1)
	go func() { answered <- g.h.Before(t.Context(), "s-b", "s-b", "call-2", heavy) }()
	select {
	case msg := <-answered:
		assert.Contains(t, msg, "mac-heavy is busy", "B is answered while A's process list is still being read")
	case <-time.After(2 * time.Second):
		close(block) // let the stuck calls end, then fail
		t.Fatal("B's call waited for A's slow process list")
	}
	assert.Equal(t, []string{"Agent A"}, g.holders(), "A keeps the slot meanwhile: an unknown list is taken as work still running")
	close(block)
	<-done
	assert.Equal(t, []string{"Agent B"}, g.holders(), "the list came back empty: A's slot goes to B, who was waiting")
}

func TestWithNoMatchingResourceNothingIsLookedUp(t *testing.T) {
	g := newHookRig(t)
	require.NoError(t, g.m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1}))
	assert.False(t, g.h.Active(), "no resource has a match")
	require.NoError(t, g.m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1, Match: []string{"go test ./..."}}))
	assert.True(t, g.h.Active())
	var none *Hook
	assert.False(t, none.Active())
}

// #13659: where the process list has no command lines (Windows) it names programs, and a slot is held while the agent still runs a program the resource is about.
func TestAProcessListOfProgramNamesHoldsTheSlotWhileThatProgramRuns(t *testing.T) {
	g := newHookRig(t)
	assert.Equal(t, "", g.h.Before(t.Context(), "s-a", "s-a", "call-1", "go test ./... &"))
	g.mu.Lock()
	g.procs["s-a"] = []string{"go", "conhost"} // image names, as a Toolhelp snapshot has them
	g.mu.Unlock()
	g.h.After("s-a", "call-1")
	assert.Equal(t, []string{"Agent A"}, g.holders(), "go is still running below the agent: the slot stays")
	g.add(10 * time.Minute)
	assert.Equal(t, []string{"Agent A"}, g.holders())
	g.mu.Lock()
	g.procs["s-a"] = []string{"conhost", "notepad"} // nothing the resource is about
	g.mu.Unlock()
	g.add(4 * time.Second)
	assert.Empty(t, g.holders(), "no program of the resource runs below the agent now: the slot goes back")
}

func TestMatchImage(t *testing.T) {
	pats := []string{"go test ./...", "node run_cdp_suites.mjs", "C:npm run x"}
	for _, yes := range []string{"go", "GO", "go.exe", "node", "node.exe"} {
		assert.True(t, MatchImage(yes, pats), yes)
	}
	for _, no := range []string{"", "gofmt", "g", "go test", "npm", "notepad", "go.exe go"} {
		assert.False(t, MatchImage(no, pats), no)
	}
}
