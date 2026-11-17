package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// A wake's pane starts at its shell and the team's spaced start types the CLI 0.7 to 6.5 s later (#18988: QA Engineer 3 marked 'CLI exited, sleeping' 0.14 s after the start was scheduled, and the
// CLI that started a second later was never taken for awake). The row is old (a wake reuses it), so the grace from created_at is long over: what holds the reconciler back is the start that is still
// to be typed, and the launch the wake stamped.
func TestReconciler_AWakeWhoseSpacedStartIsStillPendingIsNotMarkedExited(t *testing.T) {
	ss, rt, r := newExitedFixture(t) // r.now is 10 minutes on: the row's created_at grace is over
	ctx := context.Background()
	registerAwake(t, ss, "claude", testUUID)
	rt.listed = []AgentInfo{{AgentType: "claude", SessionID: testUUID}}
	name := FormatSessionName("claude", testUUID)
	rt.set(name, "zsh") // the shell the spaced start has not typed into yet

	done := ptymanager.MarkStartPending(name+".0", 0) // startAgentCLI's target is the pane: the session's name with .0 on a tmux backend
	r.reconcileOnce(ctx)
	assert.False(t, isSleeping(t, ss, testUUID), "a start still to be typed is not an exit")

	done() // the start was typed
	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID), "a real exit afterwards is still caught")
	ls, err := ss.GetLiveSession(ctx, testUUID)
	require.NoError(t, err)
	require.NotNil(t, ls.SleepReason)
	assert.Equal(t, store.SleepReasonAgentExited, *ls.SleepReason)
}

func TestReconciler_AWakeInsideItsLaunchGraceIsNotMarkedExited(t *testing.T) {
	ss, _, r, db := newReconcilerFixtureDB(t)
	rt := &fgReconRuntime{reconMockRuntime: reconMockRuntime{alive: map[string]bool{}}}
	r = NewSessionReconciler(ss, rt, time.Hour)
	ctx := context.Background()
	registerAwake(t, ss, "claude", testUUID)
	rt.listed = []AgentInfo{{AgentType: "claude", SessionID: testUUID}}
	rt.set(FormatSessionName("claude", testUUID), "zsh")
	now := time.Now().Add(3 * time.Hour) // the row was created hours ago
	r.now = func() time.Time { return now }
	_, err := db.ExecContext(ctx, "UPDATE live_sessions SET launched_at = ? WHERE session_id = ?", now.Add(-5*time.Second).UTC().Format(store.ISOFormat), testUUID) // the wake typed its launch line 5 s ago
	require.NoError(t, err)

	for i := 0; i < 3; i++ {
		r.reconcileOnce(ctx)
	}
	assert.False(t, isSleeping(t, ss, testUUID), "the grace runs from the last launch line, a wake's included")

	now = now.Add(2 * time.Minute) // the grace is over and the shell is still there: an exit
	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID), "and a real exit after it is caught")
}

// A spaced start is stamped launched_at when it is scheduled, up to a minute before the line is typed: the grace runs from the typing (#18991).
func TestReconciler_AStartTypedJustNowIsInsideItsGraceWhateverItsRowSays(t *testing.T) {
	ss, _, r, db := newReconcilerFixtureDB(t)
	rt := &fgReconRuntime{reconMockRuntime: reconMockRuntime{alive: map[string]bool{}}}
	r = NewSessionReconciler(ss, rt, time.Hour)
	ctx := context.Background()
	registerAwake(t, ss, "claude", testUUID)
	rt.listed = []AgentInfo{{AgentType: "claude", SessionID: testUUID}}
	name := FormatSessionName("claude", testUUID)
	rt.set(name, "zsh")
	now := time.Now().Add(5 * time.Second)
	r.now = func() time.Time { return now }
	old := now.Add(-3 * time.Hour).UTC().Format(store.ISOFormat)
	_, err := db.ExecContext(ctx, "UPDATE live_sessions SET created_at = ?, launched_at = ? WHERE session_id = ?", old, now.Add(-70*time.Second).UTC().Format(store.ISOFormat), testUUID) // scheduled 70 s ago
	require.NoError(t, err)

	done := ptymanager.MarkStartPending(name+".0", time.Minute)
	done() // typed just now
	r.reconcileOnce(ctx)
	assert.False(t, isSleeping(t, ss, testUUID), "the line was typed seconds ago: the grace is not over")

	now = now.Add(2 * time.Minute)
	r.reconcileOnce(ctx)
	assert.True(t, isSleeping(t, ss, testUUID), "a real exit after the grace is caught")
}
