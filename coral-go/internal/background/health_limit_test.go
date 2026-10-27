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

// #5229: an agent whose CLI says its quota is used up is BLOCKED in the check, with the reset time, not "idle" (it was counted idle, and named as an
// idle agent that needs work).
func TestHealthCheckShowsAQuotaBlockedAgentAsBlocked(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Idler", "Developer", 4, 40*time.Minute)
	h.member("Quota", "Developer", 5, 40*time.Minute) // awake, no turn, no wait, no work: idle by its hooks
	quotaSID := fmt.Sprintf("%08d-0000-0000-0000-000000000000", 5)

	before := h.check()
	assert.Contains(t, before, "2 idle", "without a limit both are idle")
	assert.NotContains(t, before, "BLOCKED")

	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) {
		if a.SessionID == quotaSID {
			return 103*time.Hour + 13*time.Minute + 54*time.Second, true
		}
		return 0, false
	}
	out := h.check()
	require.Contains(t, out, "1 BLOCKED by a usage limit", out)
	assert.Contains(t, out, "1 idle", "the other is still idle")
	assert.NotContains(t, out, "2 idle")
	assert.Contains(t, out, "Blocked by a usage limit, 1: Quota (resets in 103 h 13 min)")
	assert.NotContains(t, out, "Quota: idle", "a blocked agent is not named as one that needs work")
	assert.Contains(t, out, "Idler: idle", "an idle one still is")
	assert.False(t, strings.Contains(out, "\n"))

	// A limit with no time shown.
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) { return 0, a.SessionID == quotaSID }
	assert.Contains(t, h.check(), "Quota (reset time not shown)")
}

type screenRT struct {
	AgentRuntime
	screen string
}

func (r screenRT) AgentScreen(context.Context, string, string, string) (string, error) {
	return r.screen, nil
}

// screenLimit reads agy's quota notice off its screen, only for agy, and only when the runtime can show a screen.
func TestScreenLimitReadsAgyQuotaOnly(t *testing.T) {
	const quota = "⚠ Individual quota reached. Please upgrade. Resets in\n103h13m54s.\nError ID: x\n\n How's the CLI experience so far? Help us improve:\n [1] Good  [2] Fine  [3] Bad  [0] Skip\n"
	f := screenLimit(screenRT{screen: quota})
	require.NotNil(t, f)
	resets, blocked := f(context.Background(), AgentInfo{AgentType: "agy", SessionID: "s1"})
	assert.True(t, blocked)
	assert.Equal(t, 103*time.Hour+13*time.Minute+54*time.Second, resets)
	_, blocked = f(context.Background(), AgentInfo{AgentType: "claude", SessionID: "s1"})
	assert.False(t, blocked, "other agent types report limits through their transcripts")
	idle := screenLimit(screenRT{screen: "● Done.\n\n> \n"})
	_, blocked = idle(context.Background(), AgentInfo{AgentType: "agy", SessionID: "s1"})
	assert.False(t, blocked)
	assert.Nil(t, screenLimit(nilScreenRT{}), "a runtime with no screen sees no limit")
}

type nilScreenRT struct{ AgentRuntime }

// #9267: Codex's notice is read off its screen too.
func TestScreenLimitReadsCodexNotice(t *testing.T) {
	f := screenLimit(screenRT{screen: "■ You've hit your usage limit. Upgrade to Pro or try again at Nov 1st, 2030 10:07 PM.\n\n› \n"})
	resets, blocked := f(context.Background(), AgentInfo{AgentType: "codex", SessionID: "s1"})
	assert.True(t, blocked)
	assert.Greater(t, resets, time.Hour)
	idle := screenLimit(screenRT{screen: "› Ask Codex to do anything\n"})
	_, blocked = idle(context.Background(), AgentInfo{AgentType: "codex", SessionID: "s1"})
	assert.False(t, blocked)
}

// #9267: a limit can cut a turn short with no hook event, so an agent "in a turn" is still BLOCKED when its screen says so; and nothing is
// typed to a blocked agent.
func TestHealthCheckShowsAnInTurnAgentWithALimitAsBlocked(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0) // in a turn by its hooks
	quotaSID := h.sid(2)
	assert.Contains(t, h.check(), "1 working")
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) {
		return 5 * 24 * time.Hour, a.SessionID == quotaSID
	}
	out := h.check()
	assert.Contains(t, out, "1 BLOCKED by a usage limit", out)
	assert.Contains(t, out, "0 working", out)
	assert.Contains(t, out, "Dev (resets in 120 h)")
}

func TestSendUnlessBlockedTypesNothingToABlockedAgent(t *testing.T) {
	sent := 0
	deliver := func(context.Context, AgentInfo, string, string) error { sent++; return nil }
	blocked := func(context.Context, AgentInfo) (time.Duration, bool) { return 0, true }
	free := func(context.Context, AgentInfo) (time.Duration, bool) { return 0, false }
	a := AgentInfo{AgentType: "codex", SessionID: "s"}
	assert.ErrorIs(t, sendUnlessBlocked(context.Background(), blocked, deliver, a, "k", "x"), errBlockedByLimit)
	assert.Zero(t, sent)
	assert.NoError(t, sendUnlessBlocked(context.Background(), free, deliver, a, "k", "x"))
	assert.NoError(t, sendUnlessBlocked(context.Background(), nil, deliver, a, "k", "x"))
	assert.Equal(t, 2, sent)
}

// #9267 review: a Codex agent whose quota reset while it sat idle still shows the old notice; it is not blocked, and the nudge that wakes it
// is typed. A line that only quotes the notice (no ■ bullet) blocks nothing.
func TestStaleCodexNoticeDoesNotStopTheNudges(t *testing.T) {
	a := AgentInfo{AgentType: "codex", SessionID: "s1"}
	sent := 0
	deliver := func(context.Context, AgentInfo, string, string) error { sent++; return nil }
	for name, screen := range map[string]string{
		"the date has passed": "■ You've hit your usage limit. Upgrade to Pro or try again at Oct 20th, 2020 10:07 PM.\n\n› \n",
		"only a quote":        "Lead: You've hit your usage limit. Try again in 3 days.\n\n› \n",
	} {
		limit := screenLimit(screenRT{screen: screen})
		_, blocked := limit(context.Background(), a)
		assert.False(t, blocked, name)
		before := sent
		require.NoError(t, sendUnlessBlocked(context.Background(), limit, deliver, a, "k", "x"), name)
		assert.Equal(t, before+1, sent, name)
	}
}
