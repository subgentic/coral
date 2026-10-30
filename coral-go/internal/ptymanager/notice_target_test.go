package ptymanager

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
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
