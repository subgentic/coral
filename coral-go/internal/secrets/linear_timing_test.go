package secrets

import (
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The linear-time guards (#5018, #5242) compare a run over 250 KB with one over 1 MB. A linear pass makes the ratio about 4 and a quadratic one about 16, so the
// limit is 9, but a single collection landing in the one 1 MB run was enough to read 10.02 (16.6 ms and 166 ms on a shared runner, #131 gate): a noisy sample, not a
// slow pass. So each size is timed with the collector off and swept first, the fastest of three, and a ratio over the limit is measured once more before it fails: a
// pass that really is quadratic fails twice, a noisy sample does not.

// bestOfThree is the fastest of three runs of f over text, with garbage collection paused (and run beforehand) so a collection cannot land in the timing.
func bestOfThree(f func(string), text string) time.Duration {
	old := debug.SetGCPercent(-1)
	defer debug.SetGCPercent(old)
	best := time.Hour
	for i := 0; i < 3; i++ {
		runtime.GC()
		start := time.Now()
		f(text)
		if d := time.Since(start); d < best {
			best = d
		}
	}
	return best
}

// tooQuick is the run time under which the real guards read no ratio from a run: a few milliseconds of timer and cache noise would decide it.
const (
	tooQuick  = 150 * time.Millisecond
	smallBase = 5 * time.Millisecond // a faster small run is read as this long, so a few milliseconds of noise cannot make the ratio
)

// measureLinear times f over mk(small) and mk(large) and says whether it is linear: no more than 9 times as long (a fast small run is floored at 5 ms) in at least one
// of two measurements, or finished within quick (a run too quick to read a ratio from). The real guards pass tooQuick and smallBase.
func measureLinear(mk func(n int) string, f func(string), small, large int, quick, base time.Duration) (ds, dl time.Duration, ok bool) {
	return measureLinearUsing(bestOfThree, mk, f, small, large, quick, base)
}

// measureLinearUsing shares the growth verdict between wall-clock measurements of the
// real scanners and counted work in the guard's own test. Counting the control's work
// makes scheduler pauses irrelevant without relaxing the real guard's threshold.
func measureLinearUsing(measure func(func(string), string) time.Duration, mk func(int) string, f func(string), small, large int, quick, base time.Duration) (ds, dl time.Duration, ok bool) {
	text, big := mk(small), mk(large)
	for attempt := 0; attempt < 2; attempt++ {
		ds, dl = measure(f, text), measure(f, big)
		if dl <= quick || float64(dl)/float64(max(ds, base)) < 9.0 {
			return ds, dl, true
		}
	}
	return ds, dl, false
}

// requireLinear fails when measureLinear says the pass is not linear, or when it takes more than 10 s at all (a floor that only catches a blow-up: a shared
// runner is several times slower than a laptop).
func requireLinear(t *testing.T, name string, mk func(n int) string, f func(string), small, large int) {
	t.Helper()
	if raceEnabled { // no time is read under -race (race_on_test.go): the pass still runs over the small text
		f(mk(small))
		return
	}
	ds, dl, ok := measureLinear(mk, f, small, large, tooQuick, smallBase)
	require.True(t, ok, "%s: %v for %d bytes, %v for %d: more than 9 times as long for 4 times the text", name, ds, small, dl, large)
	require.Less(t, dl, 10*time.Second, "%s: %v for %d bytes", name, dl, large)
}

// The guard still guards: count the work done by real quadratic and linear loops.
// The same growth verdict must reject 16-fold growth and accept fourfold growth.
// A scheduler pause cannot change these counts; the real scanner checks above still
// measure elapsed time. Use one count as one duration unit, with no quick shortcut.
func TestTheLinearGuardRefusesAQuadraticPassAndAcceptsALinearOne(t *testing.T) {
	mk := func(n int) string { return strings.Repeat("a", n) }
	var operations time.Duration
	countWork := func(f func(string), text string) time.Duration {
		operations = 0
		f(text)
		return operations
	}
	quadratic := func(text string) {
		for i := 0; i < len(text); i += 50 {
			for j := 0; j < len(text); j++ {
				operations++
			}
		}
	}
	linear := func(text string) { // the same work at 200 bytes, proportional to text length
		for rep := 0; rep < 4; rep++ {
			for j := 0; j < len(text); j++ {
				operations++
			}
		}
	}
	ds, dl, ok := measureLinearUsing(countWork, mk, quadratic, 200, 800, 0, 1)
	require.Equal(t, time.Duration(800), ds)
	require.Equal(t, time.Duration(12_800), dl)
	require.False(t, ok, "a quadratic pass must fail the guard")
	ds, dl, ok = measureLinearUsing(countWork, mk, linear, 200, 800, 0, 1)
	require.Equal(t, time.Duration(800), ds)
	require.Equal(t, time.Duration(3_200), dl)
	require.True(t, ok, "a single pass must pass it")
}
