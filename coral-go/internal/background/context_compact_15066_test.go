package background

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
)

// #15066: the compaction's fixes from the Tech Lead's audit.

// A busy agent always has unread board messages, so the zero-unread condition kept it from ever being compacted. Due for ten minutes, it is compacted anyway.
func TestAnAgentDueForTenMinutesIsCompactedDespiteUnreadMessages(t *testing.T) {
	h := newCompactHarness(t, true)
	sn := h.agent("Orch", "s1", "claude", "Dev", 312000, time.Minute)
	h.unread[sn] = 3
	h.run(0)
	assert.Empty(t, h.sent(), "a fresh due waits for its messages")
	st, ok := h.c.Status(sn)
	require.True(t, ok)
	assert.Equal(t, "skipped: unread messages", st.Text)
	assert.False(t, h.c.HoldNudge(sn), "no hold yet")

	h.sig["s1"] = agentSignal{Since: h.now.Add(-time.Minute), LastEvent: h.now}
	h.run(9 * time.Minute)
	assert.Empty(t, h.sent(), "nine minutes is not ten")
	h.sig["s1"] = agentSignal{Since: h.now.Add(-time.Minute), LastEvent: h.now}
	h.run(time.Minute)
	assert.Equal(t, []string{"Orch: /compact keep: open tasks, team rules, recent decisions, and what I was last asked"}, h.sent(), "ten minutes due: compacted although it has unread messages")
	assert.False(t, h.c.HoldNudge(sn), "the hold ends when the command is in")
}

// While the override is on and the command could not go in yet (a draft in the box), the notifier holds the agent's nudge, never more than two minutes.
func TestTheNudgeIsHeldAtMostTwoMinutesWhileACompactionIsOverdue(t *testing.T) {
	h := newCompactHarness(t, true)
	sn := h.agent("Orch", "s1", "claude", "Dev", 312000, time.Minute)
	h.unread[sn] = 3
	h.skip = true
	h.run(0)
	h.sig["s1"] = agentSignal{Since: h.now.Add(-time.Minute), LastEvent: h.now}
	h.run(compactDueOverride)
	assert.True(t, h.c.HoldNudge(sn), "overdue: the nudge is held so the command goes in first")
	h.now = h.now.Add(compactHoldMax - time.Second)
	assert.True(t, h.c.HoldNudge(sn))
	h.now = h.now.Add(2 * time.Second)
	assert.False(t, h.c.HoldNudge(sn), "never held longer than two minutes")
	assert.False(t, h.c.HoldNudge("claude-other"), "another agent's nudge is not held")
}

// A compaction is typed once and the stored context reading is dropped at once, so the card shows no percentage and a cooldown that was lost in a restart does not make a stale reading due again.
func TestSendingACompactDropsTheStoredReadingAndTheCooldownSurvivesARestart(t *testing.T) {
	h := newCompactHarness(t, true)
	var mu sync.Mutex
	var marked []string
	resets := map[string]time.Time{}
	h.c.markReset = func(_ context.Context, id string) error {
		mu.Lock()
		defer mu.Unlock()
		marked = append(marked, id)
		resets[id] = h.now
		return nil
	}
	h.c.resetAt = func(_ context.Context, ids []string) map[string]time.Time {
		mu.Lock()
		defer mu.Unlock()
		out := map[string]time.Time{}
		for _, id := range ids {
			if t, ok := resets[id]; ok {
				out[id] = t
			}
		}
		return out
	}
	h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h.run(0)
	require.Len(t, h.sent(), 1)
	assert.Equal(t, []string{"s1"}, marked, "the reading is dropped when the command goes in")

	// Coral restarts: a new service, no memory of the compaction, and the old reading is still large.
	restarted := NewContextCompact(h.bs, func(context.Context) ([]AgentInfo, error) { return h.agents, nil })
	restarted.now, restarted.signal, restarted.limit, restarted.tokens, restarted.unread = h.c.now, h.c.signal, h.c.limit, h.c.tokens, h.c.unread
	restarted.deliver, restarted.paused, restarted.resetAt, restarted.markReset = h.c.deliver, h.c.paused, h.c.resetAt, h.c.markReset
	h.c = restarted
	h.run(time.Minute)
	assert.Len(t, h.sent(), 1, "an idle compacted agent is not compacted again after a restart")
	h.run(31 * time.Minute)
	assert.Len(t, h.sent(), 2, "after the cooldown it is due again")
}

// A skip is said once, with its reason, and the agent's line says it.
func TestASkipIsLoggedOnceWithItsReasonAndKeptForTheTeamSettingsLine(t *testing.T) {
	h := newCompactHarness(t, true)
	sn := h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h.skip = true // a draft is in its box
	h.run(0)
	h.run(time.Second)
	st, ok := h.c.Status(sn)
	require.True(t, ok)
	assert.Equal(t, "skipped: a dialog, a draft or a held notice is on its terminal", st.Text)
	h.skip = false
	h.run(time.Second)
	st, _ = h.c.Status(sn)
	assert.Contains(t, st.Text, "typed at ")
}

// The command is confirmed by the agent starting a turn, and said when it did not.
func TestACompactIsConfirmedByAnAgentTurnAndNotTakenIsSaid(t *testing.T) {
	h := newCompactHarness(t, true)
	sn := h.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h.run(0)
	h.sig["s1"] = agentSignal{InTurn: true, Since: h.now, LastEvent: h.now}
	h.run(5 * time.Second)
	st, _ := h.c.Status(sn)
	assert.Contains(t, st.Text, "compacted ")

	h2 := newCompactHarness(t, true)
	sn2 := h2.agent("Dev", "s1", "claude", "Dev", 312000, time.Minute)
	h2.run(0)
	h2.run(compactConfirmWait + time.Second) // still idle: the CLI did not take it
	st, _ = h2.c.Status(sn2)
	assert.Contains(t, st.Text, "not taken by the CLI")
	assert.Len(t, h2.sent(), 1, "and it is not typed again")
}

// The after-task trigger reads the team's tasks once per pass, not once per candidate.
func TestTheAfterTaskTriggerReadsTheTasksOncePerPass(t *testing.T) {
	h := newCompactHarness(t, true)
	s := h.bs
	hs := s.GetHealthSettings(context.Background(), "team")
	hs.CompactContext.Trigger = "task"
	require.NoError(t, s.SetHealthSettings(context.Background(), "team", hs))
	var calls int
	h.c.finishedAll = func(_ context.Context, _ string, ids []string) map[string]time.Time {
		calls++
		out := map[string]time.Time{}
		for _, id := range ids {
			out[id] = h.now.Add(-time.Minute)
		}
		return out
	}
	h.c.finished = nil
	for i, n := range []string{"A", "B", "C", "D"} {
		h.agent(n, "s"+string(rune('1'+i)), "claude", n, 80000, time.Minute)
	}
	h.run(0)
	assert.Equal(t, 1, calls, "one read for four candidates")
	assert.Len(t, h.sent(), 4)
	_ = naming.SessionName
}
