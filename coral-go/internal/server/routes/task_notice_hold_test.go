package routes

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/terminalinput"
)

// recordTerm is a terminal whose agent's process is recorded only at readyAt (until then it answers "being recorded": wait), and that notes when each input was typed.
type recordTerm struct {
	*mockSessionTerminal
	readyAt time.Time
	mu      sync.Mutex
	typed   []time.Time
}

func (r *recordTerm) AgentNoticeTarget(context.Context, string, string, string) (bool, bool, string, bool) {
	if time.Now().Before(r.readyAt) {
		return false, true, "the agent is starting: its process is not recorded yet", true
	}
	return true, false, "", true
}

func (r *recordTerm) SendInput(ctx context.Context, o terminalinput.Origin, name, command, agentType, sessionID string) error {
	r.mu.Lock()
	r.typed = append(r.typed, time.Now())
	r.mu.Unlock()
	return r.mockSessionTerminal.SendInput(ctx, o, name, command, agentType, sessionID)
}

var _ ptymanager.NoticeTargetChecker = (*recordTerm)(nil)

// #137853: a TASK notification sent 0.3 s before the agent's process is recorded (the stress runner's case) is typed once, after the record, never before it and never lost.
func TestATaskNotificationSentJustBeforeTheAgentsProcessIsRecordedIsTypedOnceAfterIt(t *testing.T) {
	step, max := ptymanager.NoticeHoldForTests(20*time.Millisecond, 5*time.Second)
	defer ptymanager.NoticeHoldForTests(step, max)

	const sid = "6a1b2c3d-4e5f-4061-8a7b-9c0d1e2f3a4f"
	name := "claude-" + sid
	mock := newMockTerminal()
	mock.sessions[name] = &ptymanager.PaneInfo{SessionName: name, Target: name}
	term := &recordTerm{mockSessionTerminal: mock}
	began := time.Now()
	term.readyAt = began.Add(300 * time.Millisecond)

	prompt := claimPrompt(&store.AgentTask{ID: 4, Title: "Add a battle log"})
	require.NoError(t, deliverAutomated(context.Background(), term, name, "claude", sid, prompt, "task notification"))

	term.mu.Lock()
	typed := append([]time.Time(nil), term.typed...)
	term.mu.Unlock()
	require.Len(t, typed, 1, "typed once")
	assert.GreaterOrEqual(t, typed[0].Sub(began), 300*time.Millisecond, "never before the record")
	mock.mu.Lock()
	defer mock.mu.Unlock()
	assert.Equal(t, []string{prompt}, mock.sent[name], "the whole prompt")
}
