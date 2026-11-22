package background

import (
	"context"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// rig is a resumer on a fake clock with agents that say when their limits reset; no agent runs and nothing is typed anywhere.
type limitRig struct {
	r       *LimitResumer
	now     time.Time
	on      bool
	agents  []AgentInfo
	resets  map[string]time.Time // session id -> reset; absent: not limited
	typed   map[string]time.Time // session id -> when a person last typed
	working map[string]bool
	sent    []string // "sid:text" in order
	refuse  bool     // the gate types nothing (a menu is open)
}

func newLimitRig(t *testing.T, ids ...string) *limitRig {
	t.Helper()
	g := &limitRig{now: time.Date(2026, 11, 22, 20, 0, 0, 0, time.UTC), on: true, resets: map[string]time.Time{}, typed: map[string]time.Time{}, working: map[string]bool{}}
	r := NewLimitResumer(0)
	r.now = func() time.Time { return g.now }
	for _, id := range ids {
		g.agents = append(g.agents, AgentInfo{AgentType: "codex", SessionID: id})
	}
	r.discover = func(context.Context) ([]AgentInfo, error) { return g.agents, nil }
	r.enabled = func(context.Context) bool { return g.on }
	r.limitAt = func(_ context.Context, a AgentInfo, _ time.Time) (time.Time, bool) {
		at, ok := g.resets[a.SessionID]
		return at, ok
	}
	r.working = func(_ context.Context, sid string) bool { return g.working[sid] }
	r.touched = func(sid string, since time.Time) bool { return g.typed[sid].After(since) }
	r.deliver = func(_ context.Context, a AgentInfo, text string) (bool, error) {
		if g.refuse {
			return true, nil
		}
		g.sent = append(g.sent, a.SessionID+":"+text)
		return false, nil
	}
	g.r = r
	t.Cleanup(func() {
		for _, id := range ids {
			ptymanager.NoteLimitResume(id, time.Time{})
		}
	})
	return g
}

func (g *limitRig) tick(d time.Duration) {
	g.now = g.now.Add(d)
	g.r.Tick(context.Background())
}

// #20691: the setting is off by default; with it off nothing is planned, shown or sent, whatever the agents say.
func TestALimitedAgentIsNotResumedWhileTheSettingIsOff(t *testing.T) {
	g := newLimitRig(t, "lim-off")
	g.on = false
	g.resets["lim-off"] = g.now.Add(time.Hour)
	g.tick(0)
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
	_, shown := ptymanager.LimitResumeAt("lim-off")
	assert.False(t, shown)
}

func TestALimitedAgentIsResumedOnceAfterItsResetAndTheTimeIsShownUntilThen(t *testing.T) {
	g := newLimitRig(t, "lim-one")
	reset := g.now.Add(time.Hour)
	g.resets["lim-one"] = reset
	g.tick(0)
	at, shown := ptymanager.LimitResumeAt("lim-one")
	require.True(t, shown, "the pending time is in the session data")
	assert.True(t, at.After(reset), "at the reset plus a delay, never before it")
	assert.LessOrEqual(t, at.Sub(reset), 20*time.Second)

	g.tick(59 * time.Minute)
	assert.Empty(t, g.sent, "before the reset nothing goes")
	g.tick(2 * time.Minute) // past the reset and its delay
	assert.Equal(t, []string{"lim-one:" + limitResumeText}, g.sent)
	_, shown = ptymanager.LimitResumeAt("lim-one")
	assert.False(t, shown, "sent: no longer pending")

	for i := 0; i < 5; i++ { // the notice may still read as a limit: one resume per limit event
		g.tick(time.Minute)
	}
	assert.Len(t, g.sent, 1)
}

func TestAnUnknownResetIsNeverResumed(t *testing.T) {
	g := newLimitRig(t, "lim-unk") // limitAt says false: stopped, but no time the CLI printed
	g.tick(0)
	g.tick(48 * time.Hour)
	assert.Empty(t, g.sent)
	_, shown := ptymanager.LimitResumeAt("lim-unk")
	assert.False(t, shown)
}

// The agents that wait for one reset go one after another, not together.
func TestAgentsOfOneAccountResumeStaggered(t *testing.T) {
	ids := []string{"stag-a", "stag-b", "stag-c", "stag-d", "stag-e"}
	g := newLimitRig(t, ids...)
	reset := g.now.Add(time.Hour)
	for _, id := range ids {
		g.resets[id] = reset
	}
	g.tick(0)
	var ats []time.Time
	for _, id := range ids {
		at, ok := ptymanager.LimitResumeAt(id)
		require.True(t, ok)
		ats = append(ats, at)
	}
	sort.Slice(ats, func(i, j int) bool { return ats[i].Before(ats[j]) })
	for i := 1; i < len(ats); i++ {
		assert.GreaterOrEqual(t, ats[i].Sub(ats[i-1]), 7*time.Second, fmt.Sprint("gap before agent ", i))
	}
	// and they go as their times come, not in one pass
	g.tick(time.Hour + 25*time.Second)
	first := len(g.sent)
	assert.Less(t, first, len(ids), "not all at once")
	g.tick(2 * time.Minute)
	assert.Len(t, g.sent, len(ids), "all of them in the end, once each")
}

func TestAPersonTypingToTheAgentCancelsItsResume(t *testing.T) {
	g := newLimitRig(t, "lim-typed")
	g.resets["lim-typed"] = g.now.Add(time.Hour)
	g.tick(0)
	g.typed["lim-typed"] = g.now.Add(10 * time.Minute) // the person acts before the reset
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
	_, shown := ptymanager.LimitResumeAt("lim-typed")
	assert.False(t, shown)
	g.tick(time.Hour) // and it is not planned again for the same event
	assert.Empty(t, g.sent)
}

func TestALimitThatGoesAwayBeforeItsResetCancelsTheResume(t *testing.T) {
	g := newLimitRig(t, "lim-gone")
	g.resets["lim-gone"] = g.now.Add(time.Hour)
	g.tick(0)
	delete(g.resets, "lim-gone") // a new login: no longer limited
	g.tick(10 * time.Minute)
	_, shown := ptymanager.LimitResumeAt("lim-gone")
	assert.False(t, shown)
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
}

// Codex's notice stops reading as a limit once its reset time has come; the agent still waits at its prompt.
func TestAResetThatHasComeStillResumesAnAgentWhoseNoticeNoLongerReadsAsALimit(t *testing.T) {
	g := newLimitRig(t, "lim-codex")
	g.resets["lim-codex"] = g.now.Add(time.Hour)
	g.tick(0)
	delete(g.resets, "lim-codex") // from the reset on, the screen reads as no limit
	g.tick(time.Hour + 5*time.Second)
	g.tick(time.Minute)
	assert.Equal(t, []string{"lim-codex:" + limitResumeText}, g.sent)
}

func TestAnAgentThatWorksAgainOnItsOwnIsNotTypedInto(t *testing.T) {
	g := newLimitRig(t, "lim-work")
	g.resets["lim-work"] = g.now.Add(time.Hour)
	g.tick(0)
	g.working["lim-work"] = true
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
}

func TestAnAgentThatLeavesIsNotResumedAndAnOldLimitIsNoEvent(t *testing.T) {
	g := newLimitRig(t, "lim-left", "lim-old")
	g.resets["lim-left"] = g.now.Add(time.Hour)
	g.resets["lim-old"] = g.now.Add(-3 * time.Hour) // an error left in a transcript from hours ago
	g.tick(0)
	_, shown := ptymanager.LimitResumeAt("lim-old")
	assert.False(t, shown)
	g.agents = nil // asleep or stopped
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
	_, shown = ptymanager.LimitResumeAt("lim-left")
	assert.False(t, shown)
}

// The same caps as the API-error resume: three, then it stops until a person has typed to the agent.
func TestAnAgentIsResumedAtMostThreeTimesUntilAPersonTypesToIt(t *testing.T) {
	g := newLimitRig(t, "lim-cap")
	for i := 1; i <= 5; i++ {
		g.resets["lim-cap"] = g.now.Add(time.Hour)
		g.tick(0)
		g.tick(time.Hour + 2*time.Minute)
	}
	assert.Len(t, g.sent, 3, "the fourth and fifth limits of the day are not resumed")
	g.typed["lim-cap"] = g.now.Add(time.Second) // a person types to it
	g.tick(time.Minute)
	g.resets["lim-cap"] = g.now.Add(time.Hour)
	g.tick(0)
	g.tick(time.Hour + 2*time.Minute)
	assert.Len(t, g.sent, 4, "a person's input starts the count again")
}

// A reset read off a screen as "in N hours" drifts by seconds from look to look: it is one event.
func TestAResetReadWithSecondsOfDriftIsOneEvent(t *testing.T) {
	g := newLimitRig(t, "lim-drift")
	reset := g.now.Add(time.Hour)
	for i := 0; i < 10; i++ {
		g.resets["lim-drift"] = reset.Add(time.Duration(i%2) * 70 * time.Second)
		g.tick(0)
	}
	g.tick(time.Hour + 5*time.Minute)
	assert.Equal(t, []string{"lim-drift:" + limitResumeText}, g.sent)
}

// #20697 (e): a send the gate refuses (a menu, a prompt, a draft) is not a resume: it does not use the agent's cap of three, and nothing is typed later.
func TestARefusedSendDoesNotUseTheCapAndIsNotRetried(t *testing.T) {
	g := newLimitRig(t, "lim-refused")
	g.refuse = true
	g.resets["lim-refused"] = g.now.Add(time.Hour)
	g.tick(0)
	g.tick(2 * time.Hour)
	assert.Empty(t, g.sent)
	assert.Empty(t, g.r.sent["lim-refused"], "nothing was typed, so nothing counts")
	g.refuse = false
	g.tick(time.Minute)
	assert.Empty(t, g.sent, "the event is closed: it is not typed into later")
}
