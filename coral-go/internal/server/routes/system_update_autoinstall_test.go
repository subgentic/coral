package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	setreg "github.com/subgentic/coral/internal/settings"
	"github.com/subgentic/coral/internal/store"
)

// #11170: a verified, strictly newer update is installed by Coral once it has been idle, with the click's own apply; it waits for work, never loops after a failure and never installs a stale one.
func autoEnv(t *testing.T) *relaunchEnv {
	e := newRelaunchEnv(t)
	e.agents = nil // a Coral whose agents run in tmux: the relaunch ends none of them
	e.h.AutoTimes = &autoInstallTimes{Every: time.Second, IdleFor: 5 * time.Minute, PersonQuiet: 5 * time.Minute, Backoff: 24 * time.Hour}
	e.h.Idle = func(context.Context) string { return "" }
	e.h.InFlight = func() bool { return false }
	e.h.LastPerson = func() time.Time { return time.Time{} }
	return e
}

func (e *relaunchEnv) tick() AutoInstallFacts { return e.h.AutoInstallTick(context.Background()) }

func TestAutoInstall_AnIdleCoralInstallsAVerifiedUpdateOnceAfterTheHold(t *testing.T) {
	e := autoEnv(t)
	f := e.tick()
	assert.Equal(t, autoSoon, f.State, "idle, held for a few minutes")
	assert.Zero(t, e.up.applyCount())
	e.now = e.now.Add(4 * time.Minute)
	assert.Equal(t, autoSoon, e.tick().State)
	assert.Zero(t, e.up.applyCount())
	e.now = e.now.Add(2 * time.Minute)
	f = e.tick()
	assert.Equal(t, autoStarted, f.State)
	assert.Equal(t, []string{"auto"}, e.up.applies, "the click's own apply, by 'auto'")
	for i := 0; i < 3; i++ {
		e.now = e.now.Add(time.Minute)
		e.tick()
	}
	assert.Equal(t, 1, e.up.applyCount(), "once")
}

func TestAutoInstall_AWorkingAgentOrAPersonKeepsItWaiting(t *testing.T) {
	e := autoEnv(t)
	e.h.Idle = func(context.Context) string { return "Dev is working" }
	for i := 0; i < 4; i++ {
		e.now = e.now.Add(3 * time.Minute)
		f := e.tick()
		assert.Equal(t, autoWaiting, f.State)
		assert.Equal(t, "Dev is working", f.Reason, "the reason is said")
	}
	assert.Zero(t, e.up.applyCount())

	// Idle again: the hold starts from now, not from before.
	e.h.Idle = func(context.Context) string { return "" }
	assert.Equal(t, autoSoon, e.tick().State)
	e.now = e.now.Add(4 * time.Minute)
	assert.Zero(t, e.up.applyCount())

	// Automated input in flight, and a person typing a minute ago.
	e.h.InFlight = func() bool { return true }
	assert.Equal(t, autoWaiting, e.tick().State)
	e.h.InFlight = func() bool { return false }
	e.h.LastPerson = func() time.Time { return e.now.Add(-time.Minute) }
	f := e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Contains(t, f.Reason, "typed")
	assert.Zero(t, e.up.applyCount())
}

func TestAutoInstall_ItLooksAgainJustBeforeTheApply(t *testing.T) {
	e := autoEnv(t)
	assert.Equal(t, autoSoon, e.tick().State)
	e.now = e.now.Add(6 * time.Minute)
	calls := 0
	e.h.Idle = func(context.Context) string { // idle at the first look, busy by the second (just before the apply)
		calls++
		if calls >= 2 {
			return "Dev is working"
		}
		return ""
	}
	assert.Equal(t, autoWaiting, e.tick().State)
	assert.Zero(t, e.up.applyCount(), "an agent started working in between: nothing applied")
}

func TestAutoInstall_AFailedAutomaticInstallIsNotRetriedInALoop(t *testing.T) {
	e := autoEnv(t)
	e.tick()
	e.now = e.now.Add(6 * time.Minute)
	e.up.applyErr = assert.AnError
	f := e.tick()
	assert.Equal(t, autoBackoff, f.State)
	assert.False(t, f.RetryAt.IsZero())
	e.up.applyErr = nil
	for i := 0; i < 10; i++ {
		e.now = e.now.Add(30 * time.Minute)
		assert.Equal(t, autoBackoff, e.tick().State)
	}
	assert.Zero(t, e.up.applyCount(), "no retry inside the day")
	e.now = e.now.Add(24 * time.Hour)
	e.tick() // idle again, held
	e.now = e.now.Add(6 * time.Minute)
	got := e.tick()
	assert.Equal(t, autoStarted, got.State, "after the day it tries once more: "+got.Reason)
	assert.Equal(t, 1, e.up.applyCount())

	// An apply that started and ended without an update (the updater says why) waits the day too, and a restarted Coral keeps that.
	e2 := autoEnv(t)
	e2.tick()
	e2.now = e2.now.Add(6 * time.Minute)
	assert.Equal(t, autoStarted, e2.tick().State)
	e2.up.mu.Lock()
	e2.up.rec.LastResult = &UpdateResult{Result: "coral_running", At: e2.now.Add(time.Minute)}
	e2.up.mu.Unlock()
	e2.now = e2.now.Add(2 * time.Minute)
	f = e2.tick()
	assert.Equal(t, autoBackoff, f.State)
	assert.Contains(t, f.Reason, "coral_running")
	e2.now = e2.now.Add(time.Hour)
	e2.h.startedVersion, e2.h.startedAt = "", time.Time{} // this process forgot: the file remembers
	e2.h.auto.mu.Lock()
	e2.h.auto.failure = autoInstallFailure{}
	e2.h.auto.mu.Unlock()
	assert.Equal(t, autoBackoff, e2.tick().State)
	assert.Equal(t, 1, e2.up.applyCount())
}

func TestAutoInstall_AStaleOrOlderStageIsNeverInstalled(t *testing.T) {
	for name, staged := range map[string]string{"the installed version": "1.4.130", "an older one": "1.4.129"} {
		e := autoEnv(t)
		e.up.rec.Staged.Version = staged
		e.tick()
		e.now = e.now.Add(10 * time.Minute)
		f := e.tick()
		assert.Equal(t, autoNone, f.State, name)
		assert.Zero(t, e.up.applyCount(), name)
	}
	e := autoEnv(t) // not verified, nothing staged, an unsupported install
	e.up.rec.Staged.Verified = false
	e.tick()
	e.now = e.now.Add(10 * time.Minute)
	assert.Equal(t, autoNone, e.tick().State)
	e.up.rec.Staged.Verified = true
	e.up.rec.Supported = false
	assert.Equal(t, autoNone, e.tick().State)
	e.up.rec.Supported, e.up.rec.Staged = true, nil
	assert.Equal(t, autoNone, e.tick().State)
	assert.Zero(t, e.up.applyCount())
}

func TestAutoInstall_WithTheSettingOffOnlyTheClickInstalls(t *testing.T) {
	e := autoEnv(t)
	e.settings[setreg.UpdateAutoInstall] = "false"
	e.tick()
	e.now = e.now.Add(10 * time.Minute)
	assert.Equal(t, autoOff, e.tick().State)
	assert.Zero(t, e.up.applyCount())
	assert.False(t, e.h.AutoInstallFactsNow(context.Background()).On)

	// On again: a fresh hold, then the install.
	e.settings[setreg.UpdateAutoInstall] = "true"
	assert.Equal(t, autoSoon, e.tick().State)
	e.now = e.now.Add(6 * time.Minute)
	assert.Equal(t, autoStarted, e.tick().State)
	assert.True(t, e.h.AutoInstallFactsNow(context.Background()).On)
}

func TestAutoInstall_WindowsStaysClickToInstall(t *testing.T) {
	e := autoEnv(t)
	relaunchNeedsLocalApproval = true // newRelaunchEnv restores it
	e.tick()
	e.now = e.now.Add(10 * time.Minute)
	f := e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Contains(t, f.Reason, "click")
	assert.Zero(t, e.up.applyCount())
}

func TestAutoInstall_TheStatusCarriesTheAutomaticInstallFacts(t *testing.T) {
	e := autoEnv(t)
	e.tick()
	f := e.h.AutoInstallFactsNow(context.Background())
	require.Equal(t, autoSoon, f.State)
	assert.True(t, f.On)
	assert.NotEmpty(t, f.Reason)
}

// Security's and QA's #11170 SHOULD: the click shows the person the sessions the relaunch ends (pty agents and terminals) and takes their yes; the automatic install has no yes, so it waits for none to
// exist, and for the work Coral itself runs that a restart ends.
func TestAutoInstall_ItWaitsForTheSessionsAndWorkARestartWouldEnd(t *testing.T) {
	e := autoEnv(t)
	e.agents = []RestartAgent{{SessionID: "claude-1", Name: "Dev", State: "idle"}, {SessionID: "t-1", Name: "build-shell", State: "idle"}}
	f := e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Contains(t, f.Reason, "2 sessions", "idle pty agents are ended by the relaunch too")
	assert.Contains(t, f.Reason, "click Update and relaunch")
	e.now = e.now.Add(10 * time.Minute)
	assert.Equal(t, autoWaiting, e.tick().State)
	assert.Zero(t, e.up.applyCount())

	e.agents = nil
	e.up.rec.TmuxAgentsRestart = true
	f = e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Contains(t, f.Reason, "tmux")
	e.up.rec.TmuxAgentsRestart = false

	e.h.Work = func() string { return "1 workflow run is going" }
	f = e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Equal(t, "1 workflow run is going", f.Reason)
	e.h.Work = func() string { return "" }
	assert.Equal(t, autoSoon, e.tick().State)
	assert.Zero(t, e.up.applyCount())
}

// QA's #11170 SHOULD 2: a failure is said on the control at once (not "an install is already under way"), and survives Coral coming back with the same update still staged (the updater started the old
// Coral again): the attempt is on disk from its start, so the new process waits the day and does not try again when the spacing is over.
func TestAutoInstall_AnAttemptThatDidNotFinishIsRememberedAcrossARestart(t *testing.T) {
	e := autoEnv(t)
	e.tick()
	e.now = e.now.Add(6 * time.Minute)
	require.Equal(t, autoStarted, e.tick().State)
	f, ok := e.h.readAutoFailure()
	require.True(t, ok, "the attempt is on disk from its start")
	assert.Equal(t, autoAttemptResult, f.Result)

	// a new process: no memory of it, the record shows the update still staged, the spacing is over
	h2 := e.build(e.h.Dir)
	h2.AutoTimes, h2.Idle, h2.InFlight, h2.LastPerson = e.h.AutoTimes, e.h.Idle, e.h.InFlight, e.h.LastPerson
	e.now = e.now.Add(15 * time.Minute)
	for i := 0; i < 5; i++ {
		e.now = e.now.Add(10 * time.Minute)
		got := h2.AutoInstallTick(context.Background())
		assert.Equal(t, autoBackoff, got.State)
	}
	assert.Equal(t, 1, e.up.applyCount(), "not again inside the day")
	e.now = e.now.Add(25 * time.Hour)
	assert.Equal(t, autoSoon, h2.AutoInstallTick(context.Background()).State, "after the day it may try")
}

// QA's #11170 MUST: an awake plain terminal is not idle. It has no turns, but on a pty Coral the relaunch ends it and it cannot resume; asleep, archived or running in tmux it does not count.
func TestAutoInstall_AnAwakePlainTerminalIsNotIdleOnACoralThatEndsItsTerminals(t *testing.T) {
	_, h, _, ss := setupSessionsTestServer(t)
	ctx := context.Background()
	const id = "55555555-eeee-4000-8000-000000000005"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "terminal", AgentName: "build-shell", WorkingDir: t.TempDir()}))
	assert.Equal(t, "a terminal is open", h.UpdateIdleReason(ctx))
	tmuxBacked := "tmux"
	require.NoError(t, ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: "terminal", AgentName: "build-shell", WorkingDir: t.TempDir(), Backend: &tmuxBacked}))
	assert.Empty(t, h.UpdateIdleReason(ctx), "a terminal started the tmux way survives the relaunch")
}

// Security's #11170 INFO 1: the history says who asked. An automatic install is source "auto", the person's click "local", a Hub owner's relaunch "hub": an automatic install is no longer recorded as a
// Hub relaunch.
func TestAutoInstall_TheHistoryNamesWhoAsked(t *testing.T) {
	assert.Equal(t, "auto", relaunchSource("auto"))
	assert.Equal(t, "local", relaunchSource("local"))
	assert.Equal(t, "hub", relaunchSource("hub-user-1234abcd"))

	e := autoEnv(t)
	e.tick()
	e.now = e.now.Add(6 * time.Minute)
	require.Equal(t, autoStarted, e.tick().State)
	require.NotEmpty(t, e.up.audits)
	last := e.up.audits[len(e.up.audits)-1]
	assert.Equal(t, "auto_started", last.Code)
	assert.Equal(t, "auto", last.Source)
}
