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
	assert.False(t, blocked, "a terminal that cannot tell blocks nothing")
	blocked, _ = NoticeBlocked(ctx, struct{}{}, name, "claude", "", "board message")
	assert.False(t, blocked, "a terminal without the check blocks nothing (ConPTY, until its half)")
}

func TestNoticeBlockedOffSwitch(t *testing.T) {
	prev := noticeCheckOff
	t.Cleanup(func() { noticeCheckOff = prev })
	noticeCheckOff = func() bool { return true }
	blocked, _ := NoticeBlocked(context.Background(), fakeNoticeTerm{known: true, why: "foreground"}, "claude-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b", "claude", "", "board message")
	assert.False(t, blocked, "CORAL_NOTICE_TARGET_CHECK=off restores the earlier rule")
}

func TestNoticeBlockedIgnoresATerminalAgent(t *testing.T) {
	blocked, _ := NoticeBlocked(context.Background(), fakeNoticeTerm{known: true, why: "foreground"}, "terminal-6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4b", "terminal", "", "board message")
	assert.False(t, blocked, "a terminal agent never gets automated input at all: that is decided elsewhere")
}
