package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// A FOREIGN Coral (one on a copy of another's data folder, internal/dataowner) must not auto-sleep or auto-wake that Coral's agents: auto-sleep kills a terminal, and a wake starts a CLI, both by
// itself. Its pass touches nothing, and only a person's own Send still wakes an auto-asleep agent (a person's action is not held).
func TestAForeignCoralsAutoSleepPassTouchesNothing(t *testing.T) {
	r := newSleepRig(t)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
	ls := r.pass(t) // idle for two hours, nothing in the way: a Coral of its own would put it to sleep
	assert.Equal(t, 0, ls.IsSleeping, "a foreign Coral puts no agent to sleep")
	assert.Empty(t, r.term.killed, "and kills no terminal")
	st, _ := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	assert.Zero(t, st.SleptAt, "and records nothing")
}

// Each of the three checks on the auto-sleep path is pinned by itself (Data Science's mutation read of the first commit): the loop's entry, the pass before it reads anything, and the kill.
func TestAForeignCoralsAutoSleepLoopReturnsAtOnce(t *testing.T) {
	r := newSleepRig(t)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
	done := make(chan struct{})
	ctx, cancel := context.WithCancel(r.ctx)
	t.Cleanup(cancel)
	go func() { r.h.RunAutoSleep(ctx); close(done) }() // a Coral of its own blocks here until ctx ends
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunAutoSleep kept running in a foreign Coral: its ticker would put agents to sleep")
	}
}

func TestAForeignCoralsPassReadsNothing(t *testing.T) {
	r := newSleepRig(t)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
	r.pass(t)
	assert.Zero(t, r.term.screens.Load(), "no agent's screen was read")
	assert.Zero(t, r.term.pids.Load(), "no process tree was read")
}

func TestAForeignCoralsAutoSleepOneKillsNothing(t *testing.T) {
	r := newSleepRig(t)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
	ls, err := r.ss.GetLiveSession(r.ctx, r.sid)
	require.NoError(t, err)
	r.h.autoSleepOne(r.ctx, ls, time.Hour, 0, time.Now()) // called directly, whatever the pass would have said
	ls, _ = r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 0, ls.IsSleeping, "the row was not touched")
	assert.Empty(t, r.term.killed, "and no terminal was killed")
}

func TestAForeignCoralsAutomatedWakeStartsNothing(t *testing.T) {
	r := newSleepRig(t)
	r.autoSleep(t) // asleep for being idle, as the real Coral left it
	delete(r.term.mockSessionTerminal.sessions, r.name)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })

	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid), "a delivery wakes no one in a foreign Coral")
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 1, ls.IsSleeping, "still asleep")
	r.term.mockSessionTerminal.mu.Lock()
	_, made := r.term.mockSessionTerminal.sessions[r.name]
	r.term.mockSessionTerminal.mu.Unlock()
	assert.False(t, made, "no terminal was made")

	assert.True(t, r.h.WakeIdleFor(r.ctx, r.sid, true), "a person's own Send still wakes it: a person's action is not held")
}
