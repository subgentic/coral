package background

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// #16796 (walk 32 F1, walk 37 F1): a job's prompt that Coral could not type (the gate skipped it and keeps nothing for later) left the run 'Running' for good, with an agent that never got its work and no
// chat to open. The delivery now asks again for a while (a person's send in flight is over in moments) and, when the prompt still cannot be typed, says so: the run fails with a plain reason.
func TestAPromptThatCannotBeTypedIsAskedAgainThenReportedNotLeftRunning(t *testing.T) {
	fastPromptTimings(t, time.Second)
	oldFor, oldEvery := promptRetryFor, promptRetryEvery
	promptRetryFor, promptRetryEvery = 150*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { promptRetryFor, promptRetryEvery = oldFor, oldEvery })
	rt := &fgMockRuntime{}
	l := newTestLauncher(t, rt, nil, 0)
	name := FormatSessionName("claude", testUUID)
	rt.set(name, "node") // the CLI is running

	end := ptymanager.BeginPersonSend(testUUID) // a send of a person's is in flight for good: Coral's text is skipped every time
	defer end()
	err := l.SendPrompt(context.Background(), testUUID, name, "claude", "do the task")
	require.Error(t, err, "a prompt that was never typed is reported")
	assert.True(t, errors.Is(err, ErrPromptNotTyped), err.Error())
	assert.Zero(t, rt.sentTo(name), "and nothing was typed")
}

func TestAPromptSkippedOnceIsTypedOnTheNextTry(t *testing.T) {
	fastPromptTimings(t, time.Second)
	oldFor, oldEvery := promptRetryFor, promptRetryEvery
	promptRetryFor, promptRetryEvery = 5*time.Second, 10*time.Millisecond
	t.Cleanup(func() { promptRetryFor, promptRetryEvery = oldFor, oldEvery })
	rt := &fgMockRuntime{}
	l := newTestLauncher(t, rt, nil, 0)
	name := FormatSessionName("claude", testUUID)
	rt.set(name, "node")
	end := ptymanager.BeginPersonSend(testUUID)
	go func() { time.Sleep(100 * time.Millisecond); end() }() // the person's send is over
	require.NoError(t, l.SendPrompt(context.Background(), testUUID, name, "claude", "do the task"))
	assert.Equal(t, 1, rt.sentTo(name), "typed once the person's send was over")
}
