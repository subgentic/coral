package background

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/ptymanager"
)

// #17520 (walk 74 H1): a job's agent opens on the folder-trust screen; its prompt waits for the input box and is typed once the trust question is answered.
func TestAJobPromptIsTypedOnceTheTrustQuestionIsAnswered(t *testing.T) {
	const name = "claude-17520000-2222-3333-4444-555555555555"
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	trust := " Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n\n Enter to confirm · Esc to exit\n"
	rule := strings.Repeat("─", 100)
	box := rule + "\n❯ Try \"how do I log an error?\"\n" + rule + "\n  ? for shortcuts\n"
	rt := &fgScreenRuntime{screenRuntime: screenRuntime{screen: trust}}
	rt.set(name, "node")
	l := &AgentLauncher{runtime: rt, logger: slog.Default()}
	prevDelay, prevPoll := promptInitialDelay, promptPollEvery
	promptInitialDelay, promptPollEvery = 10*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { promptInitialDelay, promptPollEvery = prevDelay, prevPoll })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := l.startPromptDelivery(ctx, "17520000-2222-3333-4444-555555555555", name, "claude", "say hello")
	time.Sleep(400 * time.Millisecond) // sleep-ok: the trust screen is open this long, unanswered
	assert.Empty(t, rt.typed(), "nothing is typed into the trust screen")
	rt.setScreen(box) // the question is answered: the input box is on screen
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the prompt was not delivered after the trust question was answered")
	}
	require.NotEmpty(t, rt.typed(), "the job's prompt is typed once the box shows")
	assert.Contains(t, rt.typed()[0], "say hello")
}

// fgScreenRuntime is a screen runtime whose agent CLI is the foreground program.
type fgScreenRuntime struct {
	screenRuntime
	fgState
}

func (f *fgScreenRuntime) AgentShellIdle(ctx context.Context, name, a, b string) (bool, string, bool) {
	return f.fgState.AgentShellIdle(ctx, name, a, b)
}

// #17520: the gate may decline to type a first prompt (a person's answer to the agent's question is still in flight); nothing else repeats a first prompt, so it is offered again, not dropped.
func TestAFirstPromptTheGateDeclinedIsOfferedAgain(t *testing.T) {
	const sid = "17520001-2222-3333-4444-555555555555"
	const name = "claude-" + sid
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	rule := strings.Repeat("─", 100)
	box := rule + "\n❯ Try \"how do I log an error?\"\n" + rule + "\n  ? for shortcuts\n"
	rt := &fgScreenRuntime{screenRuntime: screenRuntime{screen: box}}
	rt.set(name, "node")
	l := &AgentLauncher{runtime: rt, logger: slog.Default()}
	prevDelay, prevPoll, prevRetry := promptInitialDelay, promptPollEvery, promptRetryEvery
	promptInitialDelay, promptPollEvery, promptRetryEvery = 10*time.Millisecond, 10*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() { promptInitialDelay, promptPollEvery, promptRetryEvery = prevDelay, prevPoll, prevRetry })

	end := ptymanager.BeginPersonSend(sid) // the person's answer to the question is in flight
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := l.startPromptDelivery(ctx, sid, name, "claude", "say hello")
	time.Sleep(300 * time.Millisecond) // sleep-ok: the answer stays in flight this long
	assert.Empty(t, rt.typed(), "nothing is typed while the person's send is in flight")
	end()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the prompt was dropped after the first decline")
	}
	require.NotEmpty(t, rt.typed(), "the prompt is typed once the gate allows it")
	assert.Contains(t, rt.typed()[0], "say hello")
}

// #17520: a prompt that can never be typed is said, not waited on for ever: the caller is told once the time is up.
func TestAFirstPromptThatCannotBeTypedIsReported(t *testing.T) {
	const sid = "17520002-2222-3333-4444-555555555555"
	const name = "claude-" + sid
	t.Cleanup(func() { ptymanager.ForgetSession(name) })
	rt := &fgScreenRuntime{screenRuntime: screenRuntime{screen: " Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n"}}
	rt.set(name, "node")
	l := &AgentLauncher{runtime: rt, logger: slog.Default()}
	prevDelay, prevPoll, prevRetry, prevGive := promptInitialDelay, promptPollEvery, promptRetryEvery, promptGiveUp
	promptInitialDelay, promptPollEvery, promptRetryEvery, promptGiveUp = 10*time.Millisecond, 10*time.Millisecond, 20*time.Millisecond, 200*time.Millisecond
	t.Cleanup(func() {
		promptInitialDelay, promptPollEvery, promptRetryEvery, promptGiveUp = prevDelay, prevPoll, prevRetry, prevGive
	})
	end := ptymanager.BeginPersonSend(sid) // the gate declines every time
	defer end()
	reported := make(chan error, 1)
	l.startPromptDeliveryReporting(context.Background(), sid, name, "claude", "say hello", func(err error) { reported <- err })
	select {
	case err := <-reported:
		assert.ErrorIs(t, err, errPromptNotTyped)
	case <-time.After(10 * time.Second):
		t.Fatal("a prompt that could not be typed was never reported")
	}
	assert.Empty(t, rt.typed())
}
