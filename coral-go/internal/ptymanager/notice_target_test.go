package ptymanager

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeNoticeTerm struct {
	ok, wait, known bool
	why             string
}

func (f fakeNoticeTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	return f.ok, f.wait, f.why, f.known
}

// #389: a notice is typed only while the terminal says the recorded agent process is its foreground program.
func TestNoticeBlockedFollowsTheTerminalsVerdict(t *testing.T) {
	ctx := context.Background()
	const name = "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b"
	t.Cleanup(func() { clearSkipped(name); noticeLogged.Delete(name + "\x00foreground") })

	blocked, why := NoticeBlocked(ctx, fakeNoticeTerm{ok: true, known: true}, name, "claude", "", "board message")
	assert.False(t, blocked, "the agent is the foreground program")
	assert.Empty(t, why)

	blocked, why = NoticeBlocked(ctx, fakeNoticeTerm{known: true, why: "foreground"}, name, "claude", "", "board message")
	assert.True(t, blocked)
	assert.Equal(t, "foreground", why)
	s, ok := SkippedOf(name)
	assert.True(t, ok, "the dashboard says why nothing was typed")
	assert.Contains(t, s.Why, SkipNotAgent)
	assert.Contains(t, s.Why, "foreground")

	clearSkipped(name)
	blocked, _ = NoticeBlocked(ctx, fakeNoticeTerm{wait: true, known: true, why: "starting"}, name, "claude", "", "board message")
	assert.True(t, blocked, "while the agent's process is being recorded nothing is typed")
	_, ok = SkippedOf(name)
	assert.False(t, ok, "a launch moments ago is not shown as a pause")

	blocked, _ = NoticeBlocked(ctx, fakeNoticeTerm{known: false}, name, "claude", "", "board message")
	assert.True(t, blocked, "a terminal that cannot tell fails closed: nothing is typed")
}

// A real terminal or runtime without the check fails closed, so a future backend cannot silently type everywhere; only a test fake that says so is exempt.
type exemptFake struct{}

func (exemptFake) NoticeCheckNotApplicable() {}

func TestNoticeBlockedFailsClosedWithoutTheCheckUnlessATestFakeSaysSo(t *testing.T) {
	ctx := context.Background()
	const name = "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4c"
	t.Cleanup(func() { clearSkipped(name) })
	blocked, why := NoticeBlocked(ctx, struct{}{}, name, "claude", "", "board nudge")
	assert.True(t, blocked, "a backend without the check types nothing")
	assert.Contains(t, why, "cannot say")
	blocked, _ = NoticeBlocked(ctx, exemptFake{}, name, "claude", "", "board nudge")
	assert.False(t, blocked, "a test fake that says so is exempt")
	off := true
	noticeCheckOverride.Store(&off)
	t.Cleanup(func() { noticeCheckOverride.Store(nil) })
	blocked, _ = NoticeBlocked(ctx, struct{}{}, name, "claude", "", "board nudge")
	assert.False(t, blocked, "CORAL_NOTICE_TARGET_CHECK=off restores the earlier rule")
}

func TestNoticeBlockedOffSwitch(t *testing.T) {
	off := true
	noticeCheckOverride.Store(&off)
	t.Cleanup(func() { noticeCheckOverride.Store(nil) })
	blocked, _ := NoticeBlocked(context.Background(), fakeNoticeTerm{known: true, why: "foreground"}, "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b", "claude", "", "board message")
	assert.False(t, blocked, "CORAL_NOTICE_TARGET_CHECK=off restores the earlier rule")
}

func TestNoticeBlockedIgnoresATerminalAgent(t *testing.T) {
	blocked, _ := NoticeBlocked(context.Background(), fakeNoticeTerm{known: true, why: "foreground"}, "terminal-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b", "terminal", "", "board message")
	assert.False(t, blocked, "a terminal agent never gets automated input at all: that is decided elsewhere")
}

// scriptedTerm answers "the process is still being recorded" until readyAt, then "go ahead".
type scriptedTerm struct {
	readyAt time.Time
	asked   *atomic.Int32
}

func (s scriptedTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	s.asked.Add(1)
	if time.Now().Before(s.readyAt) {
		return false, true, "starting", true
	}
	return true, false, "", true
}

// #137855: a task notice that comes 0.3 s before the agent's process is recorded is held and typed once, after the record, never before it and never lost; one for which no record ever lands is
// withheld (shown as a pause, logged once) when the hold runs out.
func TestANoticeForAnAgentJustLaunchedIsHeldUntilItsProcessIsRecorded(t *testing.T) {
	const name = "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d"
	t.Cleanup(func() { clearSkipped(name); noticeLogged.Delete(name + "\x00starting") })
	step, max := noticeHoldStep, noticeHoldMax
	defer func() { noticeHoldStep, noticeHoldMax = step, max }()
	noticeHoldStep, noticeHoldMax = 20*time.Millisecond, 5*time.Second

	var asked atomic.Int32
	began := time.Now()
	blocked, why := NoticeBlockedWait(context.Background(), scriptedTerm{readyAt: began.Add(300 * time.Millisecond), asked: &asked}, name, "claude", "", "task notification")
	assert.False(t, blocked, "typed once the process is recorded")
	assert.Empty(t, why)
	assert.GreaterOrEqual(t, time.Since(began), 300*time.Millisecond, "never before the record")
	assert.Greater(t, asked.Load(), int32(3), "it asked again, not once")
	_, shown := SkippedOf(name)
	assert.False(t, shown, "a launch moments ago is never shown as a pause")

	noticeHoldMax = 150 * time.Millisecond
	asked.Store(0)
	blocked, why = NoticeBlockedWait(context.Background(), scriptedTerm{readyAt: time.Now().Add(time.Hour), asked: &asked}, name, "claude", "", "task notification")
	assert.True(t, blocked, "the record never landed: withheld")
	assert.Equal(t, "starting", why)
	s, shown := SkippedOf(name)
	require.True(t, shown, "and the dashboard says why")
	assert.Contains(t, s.Why, SkipNotAgent)
}

func TestAHeldNoticeStopsWhenItsContextEnds(t *testing.T) {
	const name = "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4e"
	t.Cleanup(func() { clearSkipped(name); noticeLogged.Delete(name + "\x00starting") })
	step := noticeHoldStep
	defer func() { noticeHoldStep = step }()
	noticeHoldStep = 20 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	var asked atomic.Int32
	began := time.Now()
	blocked, _ := NoticeBlockedWait(ctx, scriptedTerm{readyAt: time.Now().Add(time.Hour), asked: &asked}, name, "claude", "", "task notification")
	assert.True(t, blocked)
	assert.Less(t, time.Since(began), 2*time.Second, "a cancelled sender is not held for the whole hold")
}
