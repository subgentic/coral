package ptymanager

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/tmux"
)

// recordingProc is a pseudo-terminal process that records the agent's process itself (as the Windows ConPTY one does): its verdict says "wait" for the first few asks, then OK.
type recordingProc struct {
	*fakePTYProcess
	waitFor int32
	asked   atomic.Int32
}

func (r *recordingProc) AdoptAgentAfterLaunch(string) {}

func (r *recordingProc) NoticeVerdict() (tmux.NoticeVerdict, error) {
	if r.asked.Add(1) <= r.waitFor {
		return tmux.NoticeVerdict{Wait: true, Reason: tmux.ReasonAdopting}, nil
	}
	return tmux.NoticeVerdict{OK: true}, nil
}

// The no-mismatch reading of the Windows notice verdict: a task notice names the agent by its display name ("solo-agent"), the session behind it is "claude-<id>", and the record of its process is
// kept on that session. Asked by the display name with the session id, the verdict is the session's own: it waits while the record is being made, then says OK. (The tmux backend had to key its
// record by the session name for the same case; here the record lives on the session, so the lookup by session id finds it.)
func TestANoticeAskedByTheDisplayNameFindsTheRecordOfTheSessionBehindIt(t *testing.T) {
	const sid = "6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4d"
	key := naming.SessionName("claude", sid)
	b, s, fake := newFakeBackend(t, key)
	s.agentType, s.sessionID = "claude", sid
	proc := &recordingProc{fakePTYProcess: fake, waitFor: 2}
	s.proc = proc
	term := NewPTYSessionTerminal(b)

	// asked by the display name, with the session id: the record is looked up on that session
	ok, wait, why, known := term.AgentNoticeTarget(context.Background(), "solo-agent", "claude", sid)
	assert.True(t, known)
	assert.False(t, ok)
	assert.True(t, wait, "the process is still being recorded")
	assert.Equal(t, tmux.ReasonAdopting, why)

	ok, wait, _, known = term.AgentNoticeTarget(context.Background(), "solo-agent", "claude", sid)
	assert.True(t, known)
	assert.False(t, ok)
	assert.True(t, wait)

	ok, wait, why, known = term.AgentNoticeTarget(context.Background(), "solo-agent", "claude", sid)
	assert.True(t, known)
	assert.True(t, ok, "recorded: the notice may be typed")
	assert.False(t, wait)
	assert.Empty(t, why)
}

// The hold used by every task notice does the same through the display name: it waits for the record, then lets the notice through, and never reads another session's record.
func TestAHeldNoticeForAnAgentNamedByItsDisplayNameIsTypedOnceTheRecordLands(t *testing.T) {
	const sid = "7b2c3d4e-5f60-4172-8b8c-0d1e2f3a4b5c"
	key := naming.SessionName("claude", sid)
	b, s, fake := newFakeBackend(t, key)
	s.agentType, s.sessionID = "claude", sid
	proc := &recordingProc{fakePTYProcess: fake, waitFor: 3}
	s.proc = proc
	term := NewPTYSessionTerminal(b)
	setWaits(t, func(w *waitTimings) { w.noticeHoldStep, w.noticeHoldMax = 5*time.Millisecond, 5*time.Second })
	t.Cleanup(func() { clearSkipped("solo-agent"); noticeLogged.Delete("solo-agent\x00starting") })

	blocked, why := NoticeBlockedWait(context.Background(), term, "solo-agent", "claude", sid, "task notification")
	assert.False(t, blocked, "typed once the process is recorded")
	assert.Empty(t, why)
	assert.Greater(t, proc.asked.Load(), int32(3), "it asked again, not once")
}

// With only the display name and no session id, nothing is known: the lookup never lands on another session's record.
func TestADisplayNameWithoutASessionIdNamesNoSession(t *testing.T) {
	const sid = "8c3d4e5f-6071-4283-9c9d-1e2f3a4b5c6d"
	b, s, fake := newFakeBackend(t, naming.SessionName("claude", sid))
	s.agentType, s.sessionID = "claude", sid
	s.proc = &recordingProc{fakePTYProcess: fake}
	term := NewPTYSessionTerminal(b)

	_, _, _, known := term.AgentNoticeTarget(context.Background(), "solo-agent", "claude", "")
	assert.False(t, known, "a display name shared by teammates names no session")

	// a session id for a session that is not here is gone, not someone else's record
	_, _, _, known = term.AgentNoticeTarget(context.Background(), "solo-agent", "claude", "00000000-0000-4000-8000-000000000000")
	assert.False(t, known)
	require.NotNil(t, s)
}
