package routes

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

func (r *sleepRig) autoSleep(t *testing.T) {
	t.Helper()
	require.NoError(t, r.ss.SetSessionAutoSleeping(r.ctx, r.sid, time.Now()))
}

// A delivery wakes an auto-asleep agent and the clock for the thrash guard is written; the wake types the CLI's launch line and nothing else (no first prompt, no join text).
func TestWakeIdleForDeliveryWakesAnAutoAsleepAgent(t *testing.T) {
	r := newSleepRig(t)
	_, err := r.ss.SetPrompt(r.ctx, r.sid, ptr.NonEmpty("UNIQUE-FIRST-PROMPT-TEXT"))
	require.NoError(t, err)
	r.autoSleep(t)
	require.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 0, ls.IsSleeping)
	assert.Nil(t, ls.SleepReason, "the reason idle is cleared by the wake")
	st, _ := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	assert.NotZero(t, st.WokenAt, "the wake is on the thrash guard's clock")
	r.term.mu.Lock()
	defer r.term.mu.Unlock()
	for target, lines := range r.term.sent {
		for _, l := range lines {
			assert.NotContains(t, l, "UNIQUE-FIRST-PROMPT-TEXT", "the launch prompt is not sent again (%s)", target)
		}
	}
}

// A manual sleeper and an archived agent are never woken by a delivery; an awake one is already up.
func TestWakeIdleForDeliveryNeverWakesAManualSleeper(t *testing.T) {
	r := newSleepRig(t)
	require.NoError(t, r.ss.SetSessionSleeping(r.ctx, r.sid, true))
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid), "a person's Sleep stays")
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 1, ls.IsSleeping)

	r2 := newSleepRig(t)
	assert.True(t, r2.h.WakeIdleForDelivery(r2.ctx, r2.sid), "an awake agent is up")
	r3 := newSleepRig(t)
	r3.autoSleep(t)
	require.NoError(t, r3.ss.SetSessionArchived(r3.ctx, r3.sid, true))
	assert.False(t, r3.h.WakeIdleForDelivery(r3.ctx, r3.sid), "an archived agent is not woken")
	assert.False(t, r3.h.WakeIdleForDelivery(r3.ctx, "no-such-session"))
}

// The stored folder is gone: the agent is not woken, becomes a plain sleeper with the failure marked, and the board is told (Security: it does not look available for ever).
func TestWakeIdleForDeliveryWithTheFolderGone(t *testing.T) {
	r := newSleepRig(t)
	gone := t.TempDir() + "/deleted"
	_, err := r.h.db.DB.ExecContext(r.ctx, `UPDATE live_sessions SET working_dir = ? WHERE session_id = ?`, gone, r.sid)
	require.NoError(t, err)
	r.autoSleep(t)
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls, _ := r.ss.GetLiveSession(r.ctx, r.sid)
	assert.Equal(t, 1, ls.IsSleeping, "still asleep")
	assert.Equal(t, "", sleepReasonOf(ls), "no longer auto-asleep: nothing may count it as available")
	assert.Equal(t, store.StartFailureFolderGone, ptr.Value(ls.StartFailure))
	msgs, err := r.h.bs.ListMessages(r.ctx, "autosleep", 50, 0, 0)
	require.NoError(t, err)
	var told bool
	for _, m := range msgs {
		told = told || strings.Contains(m.Content, "folder this agent worked in is gone")
	}
	assert.True(t, told, "the board is told once")
}

func sleepReasonOf(ls *store.LiveSession) string { return ptr.Value(ls.SleepReason) }

// Woken within ten minutes of its auto-sleep, the agent is not put to sleep again for two hours.
func TestAutoSleepThrashGuardEndToEnd(t *testing.T) {
	r := newSleepRig(t)
	r.autoSleep(t)
	require.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid))
	ls := r.passAfter(t, 62*time.Minute) // idle again for over an hour, but woken at once after its sleep: held awake for two hours from the wake
	assert.Equal(t, 0, ls.IsSleeping, "the thrash guard holds it awake")
	ls = r.passAfter(t, 3*time.Hour) // past the two hours: asleep again
	assert.Equal(t, 1, ls.IsSleeping, "and the guard ends")
}

// What wakes an auto-asleep agent from the board: a message that mentions it, or a task assigned to it. A broadcast that names no one, "@all" included, and a manual sleeper do not.
func TestAutoAsleepNeedsAreDirectedOnly(t *testing.T) {
	r := newSleepRig(t)
	r.h.bs.SetSessionsDB(r.h.db.DB)
	r.autoSleep(t)
	need := func() int {
		t.Helper()
		ns, err := r.h.bs.AutoAsleepNeeds(r.ctx, nil)
		require.NoError(t, err)
		for _, n := range ns {
			assert.Equal(t, r.sid, n.SessionID)
		}
		return len(ns)
	}
	_, err := r.h.bs.Subscribe(r.ctx, "autosleep", "lead", "Lead", "claude-"+"11111111-1111-4111-8111-111111111111", nil, "all")
	require.NoError(t, err)
	post := func(text string) {
		_, err := r.h.bs.PostMessage(r.ctx, "autosleep", "lead", text, nil)
		require.NoError(t, err)
	}
	post("status for everyone, nothing for anybody")
	post("@all please read the new rules")
	assert.Equal(t, 0, need(), "a broadcast, @all included, wakes no one")
	post("@Developer can you look at the failing test")
	assert.Equal(t, 1, need(), "a message that mentions the agent wakes it")

	r2 := newSleepRig(t)
	r2.h.bs.SetSessionsDB(r2.h.db.DB)
	r2.autoSleep(t)
	_, err = r2.h.bs.CreateTask(r2.ctx, "autosleep", "Do the thing", "", "high", "lead", "dev")
	require.NoError(t, err)
	ns, err := r2.h.bs.AutoAsleepNeeds(r2.ctx, nil)
	require.NoError(t, err)
	assert.Len(t, ns, 1, "a task assigned to it wakes it")

	r3 := newSleepRig(t)
	r3.h.bs.SetSessionsDB(r3.h.db.DB)
	require.NoError(t, r3.ss.SetSessionSleeping(r3.ctx, r3.sid, true))
	_, err = r3.h.bs.CreateTask(r3.ctx, "autosleep", "Do the thing", "", "high", "lead", "dev")
	require.NoError(t, err)
	ns, err = r3.h.bs.AutoAsleepNeeds(r3.ctx, nil)
	require.NoError(t, err)
	assert.Empty(t, ns, "a person's Sleep is never woken by the board")
}
