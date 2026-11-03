package routes

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/background"
	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// lostAgent is an agent the reconciler put to sleep because its terminal was gone.
func (r *exitRig) lostAgent(n int, title string) string {
	r.t.Helper()
	id := r.agent(n, title, "")
	require.NoError(r.t, r.ss.SetSessionSleepingFor(context.Background(), id, store.SleepReasonTerminalGone))
	return id
}

func lostAt() time.Time { return time.Date(2026, 11, 2, 18, 23, 30, 0, time.Local) }

func TestALostTerminalServerIsToldAndItsAgentsAreWokenOneByOne(t *testing.T) {
	r := newExitRig(t)
	ctx := context.Background()
	a := r.lostAgent(1, "Backend Dev")
	b := r.lostAgent(2, "QA Engineer")

	r.h.ServerLost(ctx, background.ServerLoss{At: lostAt(), PID: 4242, SessionIDs: []string{a, b}})

	notes := r.dashboard()
	require.Len(t, notes, 1)
	assert.Equal(t, "The terminal server stopped at 18:23:30", notes[0].Title)
	assert.Contains(t, notes[0].Message, "2 agents lost their terminals")
	assert.Contains(t, notes[0].Message, "last pid 4242")
	assert.Contains(t, notes[0].Message, "waking them again")
	board := strings.Join(r.notices(), "\n")
	assert.Contains(t, board, "The terminal server stopped at 18:23:30: Backend Dev, QA Engineer")

	timers := r.takeTimers()
	require.Len(t, timers, 2, "one wake per agent")
	assert.Equal(t, time.Duration(0), timers[0].d)
	assert.Equal(t, recoverSpacing, timers[1].d, "one terminal at a time, not a dozen at once")
	for _, tm := range timers {
		tm.f()
	}
	for _, id := range []string{a, b} {
		sleeping, _ := r.asleep(id)
		assert.False(t, sleeping, "%s is awake again", id)
	}
}

func TestALostServerLeavesAloneAnAgentThatSleepsForAnotherReasonOrWokeMeanwhile(t *testing.T) {
	r := newExitRig(t)
	ctx := context.Background()
	gone := r.lostAgent(1, "Backend Dev")
	parked := r.agent(2, "QA Engineer", "") // asleep, but not because of the terminal
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, parked, store.SleepReasonCoralStopped))
	woken := r.lostAgent(3, "Lead Developer")
	require.NoError(t, r.ss.SetSessionSleeping(ctx, woken, false)) // a person woke it after the report

	r.h.ServerLost(ctx, background.ServerLoss{At: lostAt(), PID: 7, SessionIDs: []string{gone, parked, woken}})

	notes := r.dashboard()
	require.Len(t, notes, 1)
	assert.Contains(t, notes[0].Message, "1 agent lost its terminal", "only the agent that is asleep because of the lost terminal is counted")
	assert.NotContains(t, strings.Join(r.notices(), "\n"), "QA Engineer")
	timers := r.takeTimers()
	require.Len(t, timers, 1)

	// Its sleep reason changes before its turn comes: the wake does nothing.
	require.NoError(t, r.ss.SetSessionSleepingFor(ctx, gone, store.SleepReasonCoralStopped))
	timers[0].f()
	sleeping, _ := r.asleep(gone)
	assert.True(t, sleeping, "a stale timer wakes only an agent still asleep because of the lost terminal")
}

func TestALostServerWakesAgentsWhetherOrNotThisCoralOwnsTheFolder(t *testing.T) {
	r := newExitRig(t)
	ptymanager.SetForeign(true)
	t.Cleanup(func() { ptymanager.SetForeign(false) })
	a := r.lostAgent(1, "Backend Dev")

	r.h.ServerLost(context.Background(), background.ServerLoss{At: lostAt(), PID: 7, SessionIDs: []string{a}})

	timers := r.takeTimers()
	require.Len(t, timers, 1, "the Operator's rule: only the loop guard is a reason not to wake")
	timers[0].f()
	sleeping, _ := r.asleep(a)
	assert.False(t, sleeping)
	assert.NotContains(t, r.dashboard()[0].Message, "own this data folder")
}

func TestAServerThatKeepsDyingIsNotRestartedIntoALoop(t *testing.T) {
	r := newExitRig(t)
	ctx := context.Background()
	a := r.lostAgent(1, "Backend Dev")
	loss := background.ServerLoss{At: lostAt(), PID: 7, SessionIDs: []string{a}}

	r.h.ServerLost(ctx, loss)
	require.Len(t, r.takeTimers(), 1)

	r.h.ServerLost(ctx, loss) // it died again within the guard
	assert.Empty(t, r.takeTimers(), "no second automatic recovery inside the guard")
	notes := r.dashboard()
	require.Len(t, notes, 2)
	assert.Contains(t, notes[1].Message, "stopped again within")
}
