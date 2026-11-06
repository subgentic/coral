package ptymanager

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #4161, the tmux backend: a viewer that reads nothing while the agent prints is cut off and
// reported lagged once, and the tail keeps serving the others.
func TestTmuxBackendLaggingSubscriberIsCutOff(t *testing.T) {
	b := newTestTmuxBackend(t)
	// The agent prints in bursts with a pause between, not as fast as `yes` can: the tail reads everything new in one go, so a flood fills 256 chunks
	// of the reading viewer's channel inside one scheduling slice, and where the test and the tail share a single P (-cpu 1) the reader never runs in
	// between and is cut off as well (a viewer that really falls behind is meant to be: #5731).
	const burst = `while :; do head -c 3000 /dev/zero | tr '\0' x; echo; sleep 0.002; done`
	require.NoError(t, b.Spawn("lagger", "claude", t.TempDir(), "sid-lag", burst, 80, 24))
	defer b.Kill("lagger")
	time.Sleep(300 * time.Millisecond)

	stuck, err := b.Attach("lagger", "stuck")
	require.NoError(t, err)
	reader, err := b.Attach("lagger", "reader")
	require.NoError(t, err)
	got := make(chan int, 1)
	go func() {
		n := 0
		for d := range reader {
			n += len(d)
			if n > 1<<20 {
				select {
				case got <- n:
				default:
				}
			}
		}
	}()

	require.Eventually(t, func() bool { return len(stuck) == cap(stuck) }, 30*time.Second, 10*time.Millisecond)
	// The cut-off happens when the tail next pushes into the FULL channel, so the viewer must keep reading nothing until that has happened. A fixed pause here and then draining raced it: on a
	// loaded runner the tail did not push in that pause, the drain freed a slot, the next push fitted and the viewer was never cut off ("never cut off" after 10 s, #13389). Wait for the cut-off itself
	// (Lagged reports it once), still reading nothing; only then read what is left, which ends because the channel is closed.
	var cut bool
	require.Eventually(t, func() bool { cut = cut || b.Lagged("lagger", "stuck"); return cut }, 30*time.Second, 10*time.Millisecond, "a viewer that read nothing was never cut off")
	drained := make(chan struct{})
	go func() {
		for range stuck {
		}
		close(drained)
	}()
	select {
	case <-drained:
	case <-time.After(10 * time.Second):
		t.Fatal("a cut-off viewer's channel was never closed")
	}
	assert.True(t, cut, "the cut-off is reported")
	assert.False(t, b.Lagged("lagger", "stuck"), "reported once")
	assert.False(t, b.Lagged("lagger", "reader"))
	select {
	case <-got:
	case <-time.After(20 * time.Second):
		t.Fatal("the reading viewer stopped getting output")
	}
	b.Unsubscribe("lagger", "stuck")
	b.Unsubscribe("lagger", "reader")
}
