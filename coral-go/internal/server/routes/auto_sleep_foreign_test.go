package routes

import (
	"testing"

	"github.com/stretchr/testify/assert"

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
