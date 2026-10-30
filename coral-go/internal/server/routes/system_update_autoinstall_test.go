package routes

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	setreg "github.com/subgentic/coral/internal/settings"
)

// #11170: a verified, strictly newer update is installed by Coral once it has been idle, with the click's own apply; it waits for work, never loops after a failure and never installs a stale one.
func autoEnv(t *testing.T) *relaunchEnv {
	e := newRelaunchEnv(t)
	e.h.AutoTimes = &autoInstallTimes{Every: time.Second, IdleFor: 5 * time.Minute, PersonQuiet: 5 * time.Minute, Backoff: 24 * time.Hour}
	e.h.Idle = func(context.Context) string { return "" }
	e.h.InFlight = func() bool { return false }
	e.h.LastPerson = func() time.Time { return time.Time{} }
	return e
}

func (e *relaunchEnv) tick() AutoInstallFacts { return e.h.AutoInstallTick(context.Background()) }

func TestAnIdleCoralInstallsAVerifiedUpdateOnceAfterTheHold(t *testing.T) {
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

func TestAWorkingAgentOrAPersonKeepsItWaiting(t *testing.T) {
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

func TestItLooksAgainJustBeforeTheApply(t *testing.T) {
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

func TestAFailedAutomaticInstallIsNotRetriedInALoop(t *testing.T) {
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
	assert.Equal(t, autoStarted, e.tick().State, "after the day it tries once more")
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

func TestAStaleOrOlderStageIsNeverInstalled(t *testing.T) {
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

func TestWithTheSettingOffOnlyTheClickInstalls(t *testing.T) {
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

func TestWindowsStaysClickToInstall(t *testing.T) {
	e := autoEnv(t)
	relaunchNeedsLocalApproval = true // newRelaunchEnv restores it
	e.tick()
	e.now = e.now.Add(10 * time.Minute)
	f := e.tick()
	assert.Equal(t, autoWaiting, f.State)
	assert.Contains(t, f.Reason, "click")
	assert.Zero(t, e.up.applyCount())
}

func TestTheStatusCarriesTheAutomaticInstallFacts(t *testing.T) {
	e := autoEnv(t)
	e.tick()
	f := e.h.AutoInstallFactsNow(context.Background())
	require.Equal(t, autoSoon, f.State)
	assert.True(t, f.On)
	assert.NotEmpty(t, f.Reason)
}
