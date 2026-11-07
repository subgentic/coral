package background

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
)

// newDefaultCheckHarness is newCheckHarness over a store with NO health setting stored: the team is a new one and has what a new team has.
func newDefaultCheckHarness(t *testing.T) *checkHarness {
	t.Helper()
	s, err := board.NewStoreWithKey(filepath.Join(t.TempDir(), "board-default.db"), "")
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	require.False(t, s.HealthSettingStored(context.Background(), "team"), "nothing is stored")
	h := &checkHarness{t: t, s: s, now: time.Now().UTC().Add(time.Minute), sig: map[string]agentSignal{}, sent: map[string][]string{}}
	h.m = NewBoardHealthMonitor(h.s, 10*time.Minute)
	h.m.now = func() time.Time { return h.now }
	h.m.discover = func(context.Context) ([]AgentInfo, error) { return h.agents, nil }
	h.m.signal = func(_ context.Context, id string) (agentSignal, bool) { sg, ok := h.sig[id]; return sg, ok }
	h.m.deliver = func(_ context.Context, a AgentInfo, _ string, text string) error {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.sent[a.DisplayName] = append(h.sent[a.DisplayName], text)
		return nil
	}
	return h
}

// The cost of the check being on by default (#14091, the operator's question: how many health messages does a quiet new team of 3 get in its first hour with the defaults?). The settings are the defaults and are never
// set (a new team stores none); the scan is every 10 minutes, as the monitor's interval is. A check goes out when something is new, never to say "no change" (the heartbeat is off): the numbers below are what the
// defaults do, so a change that makes the first hour noisier fails here.
func firstHourChecks(t *testing.T, workerInTurn bool, workers int) int {
	t.Helper()
	h := newDefaultCheckHarness(t)
	ctx := context.Background()
	h.member("Orchestrator", "Orchestrator", 1, 0)
	for i := 0; i < workers; i++ {
		idle := time.Duration(0)
		if !workerInTurn {
			idle = time.Minute // idle from the start
		}
		h.member([]string{"Dev", "QA"}[i], "Developer", 2+i, idle)
	}
	start := h.now
	for m := 0; m <= 60; m += 10 {
		h.now = start.Add(time.Duration(m) * time.Minute)
		h.m.scan(ctx)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t.Logf("workerInTurn=%v workers=%d: %d checks in the first hour", workerInTurn, workers, len(h.sent["Orchestrator"]))
	return len(h.sent["Orchestrator"])
}

func TestANewTeamsFirstHourOfHealthChecksIsFew(t *testing.T) {
	assert.LessOrEqual(t, firstHourChecks(t, true, 2), 3, "an orchestrator and two workers in a turn with no task")
	assert.LessOrEqual(t, firstHourChecks(t, false, 2), 3, "an orchestrator and two idle workers")
	assert.LessOrEqual(t, firstHourChecks(t, true, 0), 1, "an orchestrator alone")
}
