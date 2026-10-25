package ptymanager

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #7554: the gate holds on a "needs input" state the screen does not show (an agent at its prompt, a state no hook cleared). The Operator's way out is Send now. The state check says needs input and the screen is
// a plain line with no input box: every send is held, as the operator saw.
const workingScreen = "⏺ Reading files…\n"

func holdOnFalseNeedsInput(t *testing.T, a *fakeAgent, name string, texts ...string) {
	t.Helper()
	fastGate(t)
	var mu sync.Mutex
	needs := true
	SetNeedsInputFunc(func(context.Context, string, string, string) bool { mu.Lock(); defer mu.Unlock(); return needs })
	t.Cleanup(func() { mu.Lock(); needs = false; mu.Unlock() })
	t.Cleanup(func() { DropHeld(name, "test done"); waitGateIdle(t) }) // what a test leaves held would keep the gate's loop running for the next one
	a.show(workingScreen)
	for _, text := range texts {
		d, err := DeliverAutomated(context.Background(), a.input(name, text, text, false))
		require.NoError(t, err)
		require.Equal(t, Held, d, text)
	}
	time.Sleep(80 * time.Millisecond) // several retries: the false state keeps them held
	require.Empty(t, a.sent())
}

func TestSendNowDeliversOneHeldMessageOnceAndTakesItOffTheQueue(t *testing.T) {
	a := &fakeAgent{}
	name := "claude-sendnow-one"
	holdOnFalseNeedsInput(t, a, name, "first", "second")

	list := HeldMessages(name)
	require.Len(t, list, 2)
	assert.Equal(t, "test", list[0].What)
	assert.NotEqual(t, list[0].ID, list[1].ID)

	res, err := SendHeldNow(context.Background(), name, list[0].ID)
	require.NoError(t, err)
	assert.Equal(t, SendNowResult{Sent: 1, Left: 1}, res)
	assert.Equal(t, []string{"first"}, a.sent())
	assert.Equal(t, 1, HeldCount(name))

	// A second press on the same message finds nothing: it is not typed twice.
	res, err = SendHeldNow(context.Background(), name, list[0].ID)
	require.NoError(t, err)
	assert.Equal(t, SendNowResult{Left: 1}, res)
	assert.Equal(t, []string{"first"}, a.sent())

	// The false state ends and the normal release goes: the first is not typed again, the second once.
	SetNeedsInputFunc(nil)
	require.Eventually(t, func() bool { return len(a.sent()) == 2 }, 5*time.Second, 10*time.Millisecond)
	time.Sleep(80 * time.Millisecond)
	assert.Equal(t, []string{"first", "second"}, a.sent())
	assert.Zero(t, HeldCount(name))
}

func TestSendNowAllDeliversEverythingInOrder(t *testing.T) {
	a := &fakeAgent{}
	name := "claude-sendnow-all"
	holdOnFalseNeedsInput(t, a, name, "one", "two", "three")
	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.Equal(t, SendNowResult{Sent: 3}, res)
	assert.Equal(t, []string{"one", "two", "three"}, a.sent())
	assert.Empty(t, HeldMessages(name))
}

// Several presses and the retry loop's own release at the same moment: every message is typed exactly once.
func TestSendNowRacingTheReleaseAndItselfTypesEachMessageOnce(t *testing.T) {
	a := &fakeAgent{}
	name := "claude-sendnow-race"
	holdOnFalseNeedsInput(t, a, name, "a", "b", "c", "d")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = SendHeldNow(context.Background(), name, "")
		}()
	}
	SetNeedsInputFunc(nil) // the normal release becomes possible while the presses run
	wg.Wait()
	require.Eventually(t, func() bool { return HeldCount(name) == 0 }, 5*time.Second, 10*time.Millisecond)
	assert.ElementsMatch(t, []string{"a", "b", "c", "d"}, a.sent(), "each once")
}

// A prompt that is really open still holds everything: text put into it could answer it. Nothing is typed, nothing is lost.
func TestSendNowTypesNothingIntoAPromptThatIsReallyOpen(t *testing.T) {
	a := &fakeAgent{}
	name := "claude-sendnow-prompt"
	holdOnFalseNeedsInput(t, a, name, "x", "y")
	a.show(permissionMenu)
	res, err := SendHeldNow(context.Background(), name, "")
	require.NoError(t, err)
	assert.Zero(t, res.Sent)
	assert.NotEmpty(t, res.Prompt)
	assert.Equal(t, 2, res.Left)
	assert.Empty(t, a.sent())
	assert.Len(t, HeldMessages(name), 2, "both still held")
}

func TestSendNowGivesUpWhenTheSessionIsBusyForLongerThanTheCallerWaits(t *testing.T) {
	name := "claude-sendnow-busy"
	unlock := gate.lockSession(name)
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := SendHeldNow(ctx, name, "")
	assert.ErrorIs(t, err, ErrSendNowBusy)
}
