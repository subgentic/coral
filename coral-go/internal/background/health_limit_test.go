package background

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/naming"
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

// #9361: an agent stopped by a usage limit is in a turn by its hooks (the limit cut it short with no Stop), but it is not "working with no task": the check
// says BLOCKED and the busy-with-no-task finding leaves it out, and one noted before the limit was seen is dropped, not said later.
func TestABlockedAgentIsNotWorkingWithNoTask(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	h.member("Codex", "Developer", 3, 0)
	devSID, codexSID := h.sid(2), h.sid(3)
	h.sig[devSID] = agentSignal{InTurn: true, Since: h.now.Add(-15 * time.Minute)}
	h.sig[codexSID] = agentSignal{InTurn: true, Since: h.now.Add(-15 * time.Minute)}
	h.m.limit = func(_ context.Context, a AgentInfo) (time.Duration, bool) {
		return 134 * time.Hour, a.SessionID == codexSID
	}
	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, "Dev: has been working for 15 min with no task in progress", "an agent that really works is still named")
	assert.NotContains(t, out, "Codex: has been working", "a blocked agent is not working")
	assert.Contains(t, out, "1 BLOCKED by a usage limit")
	assert.Contains(t, out, "Codex (resets in 134 h)")

	// an occurrence noted before the limit was seen (a check ran while the screen showed no notice) is dropped when the limit shows, and not said when it lifts
	require.NoError(t, h.s.AddOffBooks(context.Background(), "team", board.OffBooksBusy, "Codex", "Codex|early", "has been working for 20 min with no task in progress", h.now))
	h.now = h.now.Add(11 * time.Minute)
	out = h.scanOut()
	assert.NotContains(t, out, "Codex: has been working")
	h.m.limit = nil // the limit lifts
	h.now = h.now.Add(11 * time.Minute)
	h.sig[codexSID] = agentSignal{Since: h.now.Add(-time.Minute)} // idle again
	assert.NotContains(t, h.scanOut(), "Codex: has been working", "the dropped occurrence is gone")
}

// #9492: end to end with the real screen reader and a Codex agent (the earlier tests set the limit by hand on a "claude" member, so the agent-type filter and the screen parse were not
// in them): a Codex agent whose turn the limit cut short, 12 minutes in a turn by its hooks with no task, is BLOCKED and is NOT "working with no task", in the check, in a second
// check, and when the finding was noted before the screen showed the notice.
func TestACodexAgentAtItsLimitIsNeverWorkingWithNoTaskEndToEnd(t *testing.T) {
	h := newCheckHarness(t)
	h.member("Orchestrator", "Orchestrator", 1, 0)
	h.member("Dev", "Developer", 2, 0)
	sid := h.sid(3)
	_, err := h.s.Subscribe(context.Background(), "team", "Codex Dev", "Developer", naming.SessionName("codex", sid), nil, "all")
	require.NoError(t, err)
	h.agents = append(h.agents, AgentInfo{AgentType: "codex", SessionID: sid, DisplayName: "Codex Dev"})
	h.sig[h.sid(2)] = agentSignal{InTurn: true, Since: h.now.Add(-12 * time.Minute)}
	h.sig[sid] = agentSignal{InTurn: true, Since: h.now.Add(-12 * time.Minute)}

	// the real limit reader over the real notice (Codex's own text, with the screen under it)
	const notice = "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Nov 1st, 2030 10:07 PM.\n\n› Ask Codex to do anything\n\n  gpt-5.5 high · ~/work\n"
	h.m.limit = screenLimit(screenRT{screen: notice})

	out := h.checkTo("Orchestrator")
	assert.Contains(t, out, "Dev: has been working for 12 min with no task in progress", "an agent that really works is named")
	assert.NotContains(t, out, "Codex Dev: has been working", "a Codex agent at its limit is not working")
	assert.Contains(t, out, "1 BLOCKED by a usage limit")
	assert.Contains(t, out, "Codex Dev (resets in ")

	// a second check, later, with the same screen: still not named, and the finding is not noted behind the person's back
	h.now = h.now.Add(11 * time.Minute)
	out = h.scanOut()
	assert.NotContains(t, out, "Codex Dev: has been working")
	pending, err := h.s.PendingOffBooks(context.Background(), "team", h.now, map[string]bool{board.OffBooksBusy: true})
	require.NoError(t, err)
	for _, p := range pending {
		assert.NotContains(t, p.Agent, "Codex", "no busy-with-no-task occurrence is kept for it")
	}
}
