package background

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/store"
)

// #14772 (the Orchestrator's condition on agy auto_accept jobs): a run that runs out of its time while its agent waits at a prompt says it stopped waiting for the person's answer, in a fixed sentence, not just
// 'timeout'; a run that was not waiting is a plain timeout; either way the agent is killed (the unattended-hang bound).
func timedOutRun(t *testing.T, waiting func(context.Context, string) bool) (*store.ScheduledRun, *killRecorder) {
	t.Helper()
	ss := store.NewScheduleStore(setupTestDB(t))
	s := NewJobScheduler(ss, time.Minute)
	rt := &killRecorder{}
	s.SetRuntime(rt)
	s.SetAgentWaiting(waiting)
	s.SetLaunchFn(func(ctx context.Context, _ store.ScheduledJob, runID int64) error {
		require.NoError(t, ss.UpdateScheduledRun(context.Background(), runID, map[string]interface{}{"session_id": "sid-1"}))
		<-ctx.Done() // the agent never finishes: it sits at its prompt
		return ctx.Err()
	})
	runID, err := s.FireOneshot(context.Background(), map[string]interface{}{"prompt": "run the thing; secret-prompt-text-xyz", "agent_type": "claude", "max_duration_s": float64(1)})
	require.NoError(t, err)
	run := waitRunStatus(t, ss, runID, "killed")
	require.Eventually(t, func() bool { return len(rt.kills()) == 1 }, 5*time.Second, 20*time.Millisecond, "the agent is killed whatever the reason")
	return run, rt
}

func TestARunThatTimesOutAtAPromptSaysItStoppedWaitingForTheAnswer(t *testing.T) {
	run, _ := timedOutRun(t, func(_ context.Context, sessionID string) bool { return sessionID == "sid-1" })
	require.NotNil(t, run.ExitReason)
	assert.Equal(t, timeoutWaitingCode, *run.ExitReason)
	require.NotNil(t, run.ErrorMsg)
	assert.Equal(t, timeoutWaitingMsg, *run.ErrorMsg, "the fixed sentence")
	assert.NotContains(t, *run.ErrorMsg, "secret-prompt-text", "never built from the prompt's words")
	assert.Equal(t, "killed", run.Status)
}

func TestARunThatTimesOutNotWaitingIsAPlainTimeout(t *testing.T) {
	for name, waiting := range map[string]func(context.Context, string) bool{
		"the agent was working": func(context.Context, string) bool { return false },
		"no check wired":        nil,
	} {
		run, _ := timedOutRun(t, waiting)
		require.NotNil(t, run.ExitReason, name)
		assert.Equal(t, "timeout", *run.ExitReason, name)
		assert.True(t, run.ErrorMsg == nil || *run.ErrorMsg == "", name)
	}
}
