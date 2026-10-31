package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The orchestrator's check goes out when something changed or the heartbeat is due, not at every interval (#11431): a quiet team hears nothing between heartbeats, a change is said at the next look, the same
// finding is not said again until the heartbeat, and a finding that clears is said once.
func TestTheCheckIsQuietUntilSomethingChangesOrTheHeartbeatIsDue(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Worker", "Developer", 2, 0) // in a turn: nothing to say
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.IntervalMin, hs.HeartbeatMin, hs.AllClear = 10, 60, true
	hs.BusyNoTask.On = false // the worker in a turn with no task would be a (one-time) finding at minute 10: this team is quiet
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	sent := func() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.sent["Orchestrator"]) }
	start := h.now
	at := func(min int) int { h.now = start.Add(time.Duration(min) * time.Minute); h.m.scan(ctx); return sent() }

	assert.Equal(t, 1, at(0), "the first look says so: the check is on")
	for _, m := range []int{10, 20, 30, 40, 50} {
		assert.Equal(t, 1, at(m), "minute %d: nothing changed, so nothing is sent (it was every 10 minutes)", m)
	}
	assert.Equal(t, 2, at(60), "the heartbeat: silence means health, so a check goes out at the hour")
	assert.Equal(t, 2, at(70))

	// something changes: an agent sits idle with no work
	h.member("Idler", "Developer", 4, 40*time.Minute)
	assert.Equal(t, 3, at(80), "a new finding is said at the next look, not at the next heartbeat")
	assert.Contains(t, h.sent["Orchestrator"][2], "Idler")
	assert.Equal(t, 3, at(90), "the same finding is not said again")
	assert.Equal(t, 3, at(100))
	assert.Equal(t, 3, at(110))

	// it clears: going away is not news; the heartbeat says all is well again
	sid := func(n int) string { return fmt.Sprintf("%08d-0000-0000-0000-000000000000", n) }
	h.sig[sid(4)] = h.sig[sid(2)] // the idler takes up work: in a turn like the worker
	assert.Equal(t, 3, at(120), "a finding going away is not news")
	assert.Equal(t, 3, at(130))
	assert.Equal(t, 4, at(140), "the heartbeat, an hour after the last check, says all is well")
	assert.Equal(t, 4, at(150))

	// and it comes back: news again, because the look in between was remembered
	h.sig[sid(4)] = agentSignal{Since: h.now.Add(-40 * time.Minute)} // and stops again
	assert.Equal(t, 5, at(160), "a finding that returns is said again")
}

func TestACheckWithNothingToSayAndNoAllClearIsNeverSent(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Worker", "Developer", 2, 0)
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.IntervalMin, hs.HeartbeatMin, hs.AllClear = 10, 15, false
	hs.BusyNoTask.On = false
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	start := h.now
	for i := 0; i < 12; i++ {
		h.now = start.Add(time.Duration(i*10) * time.Minute)
		h.m.scan(ctx)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	assert.Empty(t, h.sent["Orchestrator"], "no finding and the all-clear line off: silence, heartbeat or not")
}

func TestTheHeartbeatSettingIsClampedAndDefaultsToAnHour(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.HeartbeatMin = 0
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	assert.Equal(t, 60, h.s.GetHealthSettings(ctx, "team").HeartbeatMin, "a body that does not carry it: an hour")
	hs.HeartbeatMin = 1
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	assert.Equal(t, 5, h.s.GetHealthSettings(ctx, "team").HeartbeatMin)
	hs.HeartbeatMin = 99999
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	assert.Equal(t, 1440, h.s.GetHealthSettings(ctx, "team").HeartbeatMin)
}

// An agent stopped at a dialog for the team's N minutes goes first in the check, with work or without, and it is a change worth sending (#11431, #11430 item 4).
func TestAnAgentAtADialogGoesFirstAndIsAChangeWorthSending(t *testing.T) {
	h := newCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Worker", "Developer", 2, 0)
	h.member("Idler", "Developer", 3, 40*time.Minute)
	task, err := h.s.CreateTask(ctx, "team", "Build", "", "medium", "Orchestrator")
	require.NoError(t, err)
	_, err = h.s.ClaimTask(ctx, "team", "Worker", task.ID) // the worker has work: the old check named only agents with none
	require.NoError(t, err)
	hs := h.s.GetHealthSettings(ctx, "team")
	hs.IntervalMin, hs.HeartbeatMin, hs.BusyNoTask.On = 10, 60, false
	hs.HeldNotice.AfterMin = 10
	hs.UnownedTasks.On = false // the loose task would be a finding of its own at minute 15
	require.NoError(t, h.s.SetHealthSettings(ctx, "team", hs))
	sent := func() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.sent["Orchestrator"]) }
	start := h.now
	at := func(min int) int { h.now = start.Add(time.Duration(min) * time.Minute); h.m.scan(ctx); return sent() }
	sid := func(n int) string { return fmt.Sprintf("%08d-0000-0000-0000-000000000000", n) }

	assert.Equal(t, 1, at(0), "the first look (the idler is a finding)")
	assert.Equal(t, 1, at(10), "nothing new")

	h.sig[sid(2)] = agentSignal{NeedsInput: true, Since: start.Add(16 * time.Minute)} // a dialog opened 4 minutes before the look at 20: under the team's 10
	assert.Equal(t, 1, at(20), "a dialog under N minutes old is not yet a finding: "+strings.Join(h.sent["Orchestrator"][1:], " || "))
	assert.Equal(t, 2, at(30), "past N minutes it is a change: the check goes out")
	out := h.sent["Orchestrator"][1]
	assert.Contains(t, out, "Worker: needs input, stopped at a dialog or prompt")
	assert.Less(t, strings.Index(out, "Worker: needs input"), strings.Index(out, "Idler: idle"), "the dialog is first, before the idle agent")
	assert.Equal(t, 2, at(40), "the same dialog is not said again")

	h.sig[sid(2)] = agentSignal{NeedsInput: true, Since: start.Add(35 * time.Minute)} // it was answered and another opened (at 35: 15 minutes old at the look at 50)
	assert.Equal(t, 3, at(50), "a new dialog (it began at another time) is news again")
}
