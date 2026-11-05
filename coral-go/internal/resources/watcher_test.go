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

// #13705: a holder that sits at a prompt (or is idle) does not hold the line well: the Orchestrator is told at 5 min, again at 10 (the row says Stuck), and an answered prompt, a working agent or an agent Coral cannot read is left alone.

type wclock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *wclock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *wclock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

type sig struct {
	kind  string
	since time.Time
}

type watchRig struct {
	t     *testing.T
	m     *Manager
	w     *Watcher
	c     *wclock
	said  []string
	state map[string]sig
}

func newWatchRig(t *testing.T) *watchRig {
	t.Helper()
	g := &watchRig{t: t, c: &wclock{t: time.Date(2026, 11, 5, 19, 0, 0, 0, time.UTC)}, state: map[string]sig{}}
	m, err := Open(Options{Now: g.c.now, AgeStep: -1})
	require.NoError(t, err)
	require.NoError(t, m.Queue().Define(resourcequeue.Resource{Key: "mac-heavy", Slots: 1}))
	g.m = m
	g.w = NewWatcher(m, WatchOptions{
		Now:    g.c.now,
		Signal: func(agent string) (string, time.Time) { s := g.state[agent]; return s.kind, s.since },
		Notify: func(_, text string) { g.said = append(g.said, text) },
	})
	return g
}

func (g *watchRig) claim(agent string) {
	_, err := g.m.Claim(context.Background(), "mac-heavy", agent, "")
	require.NoError(g.t, err)
}

func TestAHolderAtAPromptIsToldToTheOrchestratorAtFiveMinutesAndAgainAtTen(t *testing.T) {
	g := newWatchRig(t)
	g.claim("Codex")
	g.claim("Waiter")
	g.state["Codex"] = sig{"prompt", g.c.now()}
	g.w.Check()
	assert.Empty(t, g.said, "not yet")
	g.c.add(5 * time.Minute)
	g.w.Check()
	g.w.Check() // the same episode is said once
	require.Len(t, g.said, 1)
	assert.Contains(t, g.said[0], "Codex")
	assert.Contains(t, g.said[0], "mac-heavy")
	assert.Contains(t, g.said[0], "prompt")
	assert.Contains(t, g.said[0], "1 waiting")
	info, ok := g.w.Stuck(g.m.Queue().Snapshot().Entries[0].ID)
	assert.True(t, ok)
	assert.Equal(t, "prompt", info.Kind)
	assert.Equal(t, 1, info.Level)
	g.c.add(5 * time.Minute)
	g.w.Check()
	g.w.Check()
	require.Len(t, g.said, 2, "the second notice at ten minutes, once")
	assert.Contains(t, g.said[1], "10 min")
	assert.Contains(t, g.said[1], "kick")
	info, _ = g.w.Stuck(g.m.Queue().Snapshot().Entries[0].ID)
	assert.Equal(t, 2, info.Level)
}

func TestAnAnsweredPromptWorkingOrUnknownIsLeftAloneAndAFreshOneStartsOver(t *testing.T) {
	g := newWatchRig(t)
	g.claim("Codex")
	g.state["Codex"] = sig{"prompt", g.c.now()}
	g.c.add(6 * time.Minute)
	g.w.Check()
	require.Len(t, g.said, 1)
	g.state["Codex"] = sig{} // answered: working again
	g.w.Check()
	_, ok := g.w.Stuck(g.m.Queue().Snapshot().Entries[0].ID)
	assert.False(t, ok, "no longer stuck")
	g.c.add(20 * time.Minute)
	g.w.Check()
	assert.Len(t, g.said, 1, "working says nothing")
	g.state["Codex"] = sig{"prompt", g.c.now()} // a new prompt starts a new episode
	g.c.add(5 * time.Minute)
	g.w.Check()
	assert.Len(t, g.said, 2, "the new episode is told again")
	delete(g.state, "Codex") // Coral cannot read the agent: nothing happens, ever
	g.c.add(time.Hour)
	g.w.Check()
	assert.Len(t, g.said, 2)
}

func TestAnIdleHolderIsCountedFromWhenItWasGrantedNotFromAnOlderIdle(t *testing.T) {
	g := newWatchRig(t)
	g.state["Dev"] = sig{"idle", g.c.now().Add(-2 * time.Hour)} // idle long before it asked
	g.claim("Dev")
	g.w.Check()
	assert.Empty(t, g.said, "idle for hours, but it only just took the slot")
	g.c.add(5 * time.Minute)
	g.w.Check()
	require.Len(t, g.said, 1)
	assert.Contains(t, g.said[0], "idle")
}

func TestTheOperatorAndAWaitingEntryAreNeverStuck(t *testing.T) {
	g := newWatchRig(t)
	g.claim("Operator")
	g.claim("Waiter")
	g.state["Operator"] = sig{"prompt", g.c.now()}
	g.state["Waiter"] = sig{"prompt", g.c.now()}
	g.c.add(30 * time.Minute)
	g.w.Check()
	assert.Empty(t, g.said)
	assert.False(t, strings.Contains(strings.Join(g.said, ""), "Waiter"))
}
