package background

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
	"github.com/subgentic/coral/internal/store"
)

// #16421: a scheduled run's first prompt is held by the CLI's trust-this-folder card; nobody is there to answer it, so the launch says so instead of leaving the run Running until its time is out.

// trustCardAgent shows Claude's real trust screen (a fixture) and never changes it.
type trustCardAgent struct {
	fgMockRuntime
	screen string
}

func (a *trustCardAgent) AgentScreen(context.Context, string, string, string) (string, error) {
	return a.screen, nil
}

func TestAFirstPromptHeldByTheTrustCardSaysSo(t *testing.T) {
	fastPromptTimings(t, 30*time.Second)
	raw, err := os.ReadFile("../ptymanager/testdata/screens/claude/2.1.300/trust.ansi")
	require.NoError(t, err)
	rt := &trustCardAgent{screen: string(raw)}
	l := newTestLauncher(t, rt, nil, 0)
	name := FormatSessionName("claude", testUUID)
	rt.set(name, "node")

	ctx := ptymanager.WithLaunchWait(context.Background(), 50*time.Millisecond)
	err = l.SendPrompt(ctx, testUUID, name, "claude", "say hello")
	assert.True(t, errors.Is(err, errHeldAtPrompt), "the held prompt is reported: %v", err)
	assert.Zero(t, rt.sentTo(name), "nothing is typed into the card")

	// The watcher of the run ends it at once with that answer.
	held := make(chan struct{})
	close(held)
	assert.True(t, errors.Is(l.watchSession(context.Background(), name, held), errHeldAtPrompt), "the run ends as held at a prompt")
}

// A run whose launch answers errHeldAtPrompt ends failed at once with the fixed code and sentence (the card is the person's to answer), not Running until its time runs out.
func TestARunHeldAtAPromptEndsWithItsOwnCodeAndSentence(t *testing.T) {
	ctx := context.Background()
	s, ss, job := jobWithRuns(t)
	_, err := ss.UpdateScheduledJob(ctx, job.ID, map[string]interface{}{"no_worktree": 1})
	require.NoError(t, err)
	s.SetLaunchFn(func(context.Context, store.ScheduledJob, int64) error { return errHeldAtPrompt })
	id, err := s.RunNow(ctx, job.ID)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		r, _ := ss.GetScheduledRun(ctx, id)
		return r != nil && r.Status != "running" && r.Status != "pending"
	}, 15*time.Second, 20*time.Millisecond)
	r, err := ss.GetScheduledRun(ctx, id)
	require.NoError(t, err)
	assert.Equal(t, "failed", r.Status)
	require.NotNil(t, r.ExitReason)
	assert.Equal(t, heldAtPromptCode, *r.ExitReason)
	require.NotNil(t, r.ErrorCode)
	assert.Equal(t, heldAtPromptCode, *r.ErrorCode)
	require.NotNil(t, r.ErrorMsg)
	assert.Equal(t, heldAtPromptMsg, *r.ErrorMsg)
}
