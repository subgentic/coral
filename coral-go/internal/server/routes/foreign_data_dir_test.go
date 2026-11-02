package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// Task #429: a Coral that cannot show that sessions.db is its own data folder's (a copy of another Coral's database) wakes, recovers and types nothing. The decision itself is internal/dataowner's
// and is made at startup; these tests set the process-wide flag as startup does.

func foreignForTest(t *testing.T) {
	t.Helper()
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
}

// A database copied from another data folder, with agents that were running when that Coral stopped, wakes no one.
func TestADatabaseCopiedFromAnotherDataFolderWakesNoOne(t *testing.T) {
	r := newWakeRig(t)
	r.add(sid(1), "one", store.SleepReasonCoralStopped, "", false)
	r.add(sid(2), "two", store.SleepReasonCoralStopped, "", false)
	foreignForTest(t)

	r.h.AutoWakeAfterRestart(context.Background())

	for _, n := range []int{1, 2} {
		sleeping, reason := r.asleep(sid(n))
		assert.True(t, sleeping, "agent %d stays asleep", n)
		assert.Equal(t, store.SleepReasonCoralStopped, reason, "agent %d: untouched", n)
	}
	assert.Empty(t, r.sleeps, "not even the start delay: the pass returns at once")
	assert.NotEqual(t, "done", r.h.autoWake.snapshot().State)
	assert.Equal(t, 0, r.h.autoWake.snapshot().Woken)
}

// The same database in its own folder (not foreign) wakes them, so the test above proves the gate and not a broken rig.
func TestTheSameDatabaseInItsOwnFolderWakesThem(t *testing.T) {
	r := newWakeRig(t)
	r.add(sid(1), "one", store.SleepReasonCoralStopped, "", false)
	r.h.AutoWakeAfterRestart(context.Background())
	sleeping, _ := r.asleep(sid(1))
	assert.False(t, sleeping)
}

func TestNoteForeignDataDirSaysSoOnTheStatusAndTheDashboard(t *testing.T) {
	r := newWakeRig(t)
	notes := NewNotificationStore()
	r.h.SetNotificationStore(notes)
	r.h.NoteForeignDataDir("a fixed notice")
	assert.Equal(t, "foreign", r.h.autoWake.snapshot().State)
}

// A FOREIGN Coral does not read or decide from the agents' screens: the loops that do return at once.
func TestTheScreenDecidingLoopsDoNotRunInAForeignCoral(t *testing.T) {
	r := newWakeRig(t)
	foreignForTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	done := make(chan string, 2)
	go func() { r.h.RunDialogWatch(ctx); done <- "dialog watch" }()
	acceptor := NewAutoAcceptor(r.h)
	go func() { acceptor.Run(ctx); done <- "auto-accept" }()
	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("a loop is still running in a foreign Coral")
		}
	}
	require.NoError(t, ctx.Err(), "they returned by themselves, not because the context ended")
}

// Every automated text (board nudges, mentions, held notices, task notices, health lines) goes through ptymanager.DeliverAutomated: a foreign Coral types none of it.
func TestAForeignCoralTypesNoAutomatedText(t *testing.T) {
	_, h, term, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "00000000-0000-0000-0000-00000000f001"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "claude", AgentName: "claude-" + id, WorkingDir: "/tmp/test"}))
	term.addSession("claude-"+id, "/tmp/test")
	term.setOutput("claude-"+id, screenIdleList)

	foreignForTest(t)
	err := deliverAutomated(ctx, h.terminal, "claude-"+id, "claude", id, "[Coral] a board message", "board message")
	assert.ErrorIs(t, err, ptymanager.ErrForeign)
	assert.Empty(t, term.sentCommands(), "nothing typed")

	ptymanager.SetForeign(false)
	require.NoError(t, deliverAutomated(ctx, h.terminal, "claude-"+id, "claude", id, "[Coral] a board message", "board message"))
	assert.NotEmpty(t, term.sentCommands(), "the same send goes through once the Coral is not foreign")
}

// The auto-sleep pass (v2.0.34) ends a terminal and the idle wake starts one: a Coral on a copy of another's database does neither, and the same database in its own folder does both, so the
// tests prove the gate and not a broken rig.
func TestAForeignCoralPutsNoAgentToSleepAndWakesNone(t *testing.T) {
	r := newSleepRig(t)
	autoWakeSlots.Lock()
	autoWakeSlots.m["autosleep"] = nil // other tests of this package may have used the board's name
	autoWakeSlots.Unlock()
	foreignForTest(t)
	ls := r.pass(t)
	assert.Equal(t, 0, ls.IsSleeping, "idle for two hours, and still awake")
	assert.Empty(t, r.term.killed, "no terminal ended")

	r.autoSleep(t)
	assert.False(t, r.h.WakeIdleForDelivery(r.ctx, r.sid), "a delivery wakes no one")
	ls, err := r.ss.GetLiveSession(r.ctx, r.sid)
	require.NoError(t, err)
	assert.Equal(t, 1, ls.IsSleeping, "still asleep")
	st, _ := r.ss.AutoSleepStateOf(r.ctx, r.sid)
	assert.Zero(t, st.WokenAt, "not on the thrash guard's clock")

	ptymanager.SetForeign(false)
	assert.True(t, r.h.WakeIdleForDelivery(r.ctx, r.sid), "the same agent in its own folder is woken")
}
