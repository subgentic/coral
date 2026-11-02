package agent

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func withStagger(t *testing.T, gap time.Duration) {
	t.Helper()
	oldGap := SharedHomeStartGap
	SharedHomeStartGap = gap
	SetStartStagger(true)
	startSlots.mu.Lock()
	startSlots.last = map[string]time.Time{}
	startSlots.mu.Unlock()
	t.Cleanup(func() { SharedHomeStartGap = oldGap; SetStartStagger(false) })
}

// #6848: one slot keeper for every launch path, Codex only.
func TestStaggerStartSpacesCodexOnly(t *testing.T) {
	withStagger(t, 300*time.Millisecond)
	var mu sync.Mutex
	var codex, claude []time.Time
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		for _, kind := range []string{"codex", "claude"} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				require.NoError(t, StaggerStart(context.Background(), kind))
				mu.Lock()
				defer mu.Unlock()
				if kind == "codex" {
					codex = append(codex, time.Now())
				} else {
					claude = append(claude, time.Now())
				}
			}()
		}
	}
	wg.Wait()
	require.Len(t, codex, 3)
	spread := func(ts []time.Time) (min, max time.Time) {
		min, max = ts[0], ts[0]
		for _, x := range ts {
			if x.Before(min) {
				min = x
			}
			if x.After(max) {
				max = x
			}
		}
		return
	}
	cmin, cmax := spread(codex)
	assert.GreaterOrEqual(t, cmax.Sub(cmin), 550*time.Millisecond, "three codex starts take two gaps")
	lmin, lmax := spread(claude)
	assert.Less(t, lmax.Sub(lmin), 100*time.Millisecond, "claude is not delayed")
}

// A start cancelled while it waits gives its slot back: the next one does not wait for a start that never happens (Security's #6844 LOW).
func TestStaggerStartGivesTheSlotBackOnCancel(t *testing.T) {
	withStagger(t, 600*time.Millisecond)
	require.NoError(t, StaggerStart(context.Background(), "codex")) // takes the slot at now
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- StaggerStart(ctx, "codex") }() // reserves now+gap and waits
	time.Sleep(100 * time.Millisecond)
	cancel()
	require.ErrorIs(t, <-done, context.Canceled)

	start := time.Now()
	require.NoError(t, StaggerStart(context.Background(), "codex"))
	// without the give-back this waits for the cancelled run's slot (now+gap) AND then a gap after it: about 1.1 s; with it, only the first slot's gap
	assert.Less(t, time.Since(start), 600*time.Millisecond, "the cancelled run's slot was returned")
}

// Off (a test, any caller that never turns it on): nothing waits.
func TestStaggerStartIsOffUnlessTurnedOn(t *testing.T) {
	SetStartStagger(false)
	start := time.Now()
	for i := 0; i < 3; i++ {
		require.NoError(t, StaggerStart(context.Background(), "codex"))
	}
	assert.Less(t, time.Since(start), 100*time.Millisecond)
}

// The non-blocking form (a launch request's): the waits grow by the gap each and nothing sleeps; Codex only; off unless turned on.
func TestReserveStartReturnsTheWaitWithoutSleeping(t *testing.T) {
	withStagger(t, 400*time.Millisecond)
	start := time.Now()
	w0 := ReserveStart("codex")
	w1 := ReserveStart("codex")
	w2 := ReserveStart("codex")
	assert.Less(t, time.Since(start), 50*time.Millisecond, "it never sleeps")
	assert.Zero(t, w0, "the first start is now")
	assert.InDelta(t, float64(400*time.Millisecond), float64(w1), float64(60*time.Millisecond))
	assert.InDelta(t, float64(800*time.Millisecond), float64(w2), float64(60*time.Millisecond))
	assert.Zero(t, ReserveStart("claude"), "another agent is never spaced")
	SetStartStagger(false)
	assert.Zero(t, ReserveStart("codex"), "off: nothing waits")
}

// #12052 (the Hermes tester's run, three agents at once): Hermes runs a gateway per home and refuses to start one while it believes another owns the host ("Another gateway already owns this host", status 75) when
// two start in the same moment: one of three dropped to a plain shell. Hermes starts are spaced HermesStartGap apart, as Codex's are, and the others are not.
func TestHermesStartsAreSpacedAndOthersAreNot(t *testing.T) {
	withStagger(t, time.Hour)
	first, _, hadFirst, ok := reserve("hermes")
	require.True(t, ok, "Hermes is staggered")
	assert.False(t, hadFirst)
	second, prev, hadSecond, ok := reserve("hermes")
	require.True(t, ok)
	assert.True(t, hadSecond)
	assert.Equal(t, first, prev)
	assert.GreaterOrEqual(t, second.Sub(first), HermesStartGap, "the second Hermes start waits for its slot")
	third, _, _, _ := reserve("hermes")
	assert.GreaterOrEqual(t, third.Sub(second), HermesStartGap)
	for _, other := range []string{"claude", "gemini", "pi", "opencode", "agy"} {
		_, _, _, ok := reserve(other)
		assert.False(t, ok, other+" is not staggered")
	}
	codexSlot, _, _, ok := reserve("codex")
	require.True(t, ok)
	assert.Less(t, codexSlot.Sub(first), time.Minute, "Codex keeps its own gap, not Hermes's")
}
