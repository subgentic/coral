package resources

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const linuxOut = ` 10:00:01 up 3 days,  2:01,  1 user,  load average: 4.00, 3.50, 3.00
---
8
---
/dev/sda1  102400000  50000000  52428800  49% /
---
Mem:  32000  8000  20000  100  4000  24000
`

// A remote machine's stats are read from one fixed command's output (#17560).
func TestRemoteStatsAreParsedFromTheFixedCommand(t *testing.T) {
	st := ParseRemoteStats(linuxOut)
	assert.Equal(t, "ok", st.State)
	assert.Equal(t, 8, st.CPUCount)
	assert.InDelta(t, 0.5, st.LoadPerCore, 0.001, "load 4.00 over 8 cores")
	assert.Equal(t, int64(24000), st.MemAvailMB)
	assert.InDelta(t, 50.0, st.DiskFreeGB, 0.1, "52428800 KB free")
	assert.Equal(t, "unavailable", ParseRemoteStats("not what we asked for").State, "nothing readable is not guessed")
}

func TestStatsAreCachedAndUnreachableIsSaid(t *testing.T) {
	var calls atomic.Int32
	var gotAlias, gotScript string
	now := time.Now()
	b := &StatsBoard{Now: func() time.Time { return now }, Run: func(_ context.Context, alias, script string) (string, error) {
		calls.Add(1)
		gotAlias, gotScript = alias, script
		return linuxOut, nil
	}}
	assert.Equal(t, "checking", b.Get("Epoch", "remote").State, "a first look at a remote box never waits on ssh (#17656)")
	var st *Stats
	require.Eventually(t, func() bool { st = b.Get("Epoch", "remote"); return st.State == "ok" }, 5*time.Second, 5*time.Millisecond)
	assert.Equal(t, "epoch", gotAlias, "the machine's name as an ssh host, nothing else")
	assert.Equal(t, statsScript, gotScript, "the command is the fixed one: no text from a description or an agent")
	assert.False(t, strings.ContainsAny(gotScript, "$`\\"), "and it has no substitution")
	b.Get("Epoch", "remote")
	b.Get("Epoch", "remote")
	assert.Equal(t, int32(1), calls.Load(), "three looks inside the minute are one ssh call")

	down := &StatsBoard{Run: func(context.Context, string, string) (string, error) { return "", errors.New("timed out") }}
	require.Eventually(t, func() bool { return down.Get("mini", "remote").State == "unreachable" }, 5*time.Second, 5*time.Millisecond)
	assert.Contains(t, down.Get("mini", "remote").Words(), "unreachable")

	assert.Nil(t, b.Get("Epoch", ""), "a resource that does not say where it is has no stats")
	noHost := &StatsBoard{Run: b.Run}
	require.Eventually(t, func() bool { return noHost.Get("!!!", "remote").State == "unavailable" }, 5*time.Second, 5*time.Millisecond)
	var seen string
	odd := &StatsBoard{Run: func(_ context.Context, alias, _ string) (string, error) { seen = alias; return linuxOut, nil }}
	require.Eventually(t, func() bool { return odd.Get("-oProxyCommand=x; rm -rf /", "remote").State == "ok" }, 5*time.Second, 5*time.Millisecond)
	assert.Equal(t, "oproxycommand-x-rm-rf", seen, "any other name becomes a plain slug that cannot be an ssh option")
	assert.Equal(t, "ok", (&StatsBoard{}).Get("here", "here").State, "this machine is read directly")
}

// A pool takes no new run on a box whose last sample says it is unreachable or short of memory or disk; with no sample it stays open (#17586).
func TestAPoolVetoReadsOnlyWhatIsAlreadyKnown(t *testing.T) {
	b := &StatsBoard{Run: func(context.Context, string, string) (string, error) { return "", errors.New("down") }}
	assert.False(t, b.Closed("epoch", "remote"), "nothing known yet: open, and no read is started")
	b.cache = map[string]Stats{"remote:epoch": {State: "ok", MemAvailMB: 500, DiskFreeGB: 50}, "remote:full": {State: "ok", MemAvailMB: 9000, DiskFreeGB: 1}, "remote:fine": {State: "ok", MemAvailMB: 9000, DiskFreeGB: 50}, "remote:gone": {State: "unreachable"}}
	assert.True(t, b.Closed("epoch", "remote"), "under 1 GB of memory")
	assert.True(t, b.Closed("full", "remote"), "under 2 GB of disk")
	assert.True(t, b.Closed("gone", "remote"))
	assert.False(t, b.Closed("fine", "remote"))
}

// Several unreachable boxes and several looks at once must not hold a list or a claim: a cold look answers "checking" at once and starts one read per box (#17656); ssh output is cut at a cap.
func TestAColdLookNeverWaitsOnSshAndStartsOneReadPerBox(t *testing.T) {
	release := make(chan struct{})
	var calls atomic.Int32
	b := &StatsBoard{Run: func(context.Context, string, string) (string, error) { calls.Add(1); <-release; return linuxOut, nil }}
	start := time.Now()
	for i := 0; i < 20; i++ {
		for _, m := range []string{"epoch", "mini", "frontier"} {
			assert.Equal(t, "checking", b.Get(m, "remote").State)
		}
	}
	assert.Less(t, time.Since(start), 2*time.Second, "sixty cold looks at three blocked boxes returned without waiting")
	require.Eventually(t, func() bool { return calls.Load() == 3 }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, int32(3), calls.Load(), "one read in flight per box, not one per look")
	assert.Nil(t, b.Cached("epoch", "remote"), "a box not yet read is not closed by the veto")
	close(release)
	require.Eventually(t, func() bool { return b.Get("epoch", "remote").State == "ok" }, 5*time.Second, 5*time.Millisecond)

	c := &cappedBuffer{max: 10}
	n, err := c.Write([]byte(strings.Repeat("x", 25)))
	assert.NoError(t, err)
	assert.Equal(t, 25, n, "the writer is never told it was cut, so ssh does not block")
	assert.Len(t, c.b.String(), 10)
}

// #21948: a Windows box takes the ssh connection but cmd.exe cannot run the Unix command; that is "up, no stats", never "unreachable". A connection failure still is.
func TestAConnectedMachineThatCannotRunTheCommandIsUpWithNoStats(t *testing.T) {
	now := time.Now()
	run := func(out string, err error) *StatsBoard {
		return &StatsBoard{Now: func() time.Time { return now }, Run: func(context.Context, string, string) (string, error) { return out, err }}
	}
	st := run("The system cannot find the path specified.\n", &RemoteExit{Code: 1}).remoteStats("frontier")
	assert.Equal(t, NoStats, st.State)
	assert.Equal(t, "up (no stats on this OS)", st.Words())
	assert.False(t, (&StatsBoard{cache: map[string]Stats{"remote:frontier": st}}).Closed("frontier", "remote"), "an up box with no numbers stays open to runs")

	assert.Equal(t, "unreachable", run("", errors.New("exit status 255")).remoteStats("frontier").State, "ssh failing to connect is still unreachable")
	assert.Equal(t, "ok", run(linuxOut, &RemoteExit{Code: 1}).remoteStats("epoch").State, "a Unix box whose last command exits non-zero still reads")
	assert.Equal(t, "ok", run(linuxOut, nil).remoteStats("epoch").State)
}

// #22128: Windows' cmd.exe exits 255 on the stats script's POSIX redirects, the code ssh uses for a connection failure, so frontier showed unreachable and was closed to pool runs while its logins worked.
// A failed read is told apart by one "exit 0" probe that every shell runs alike: it connects, so the box is up with no stats; it does not, so it is unreachable. A read that timed out is not probed again.
func TestAWindowsBoxWhoseShellExits255IsUpNotUnreachable(t *testing.T) {
	board := func(stats, probe error) (*StatsBoard, *[]string) {
		var ran []string
		return &StatsBoard{Run: func(_ context.Context, _, script string) (string, error) {
			ran = append(ran, script)
			if script == connectProbe {
				return "", probe
			}
			return "", stats
		}}, &ran
	}
	exit255 := errors.New("exit status 255")

	b, ran := board(exit255, nil)
	st := b.remoteStats("frontier")
	assert.Equal(t, NoStats, st.State, "the shell's 255, and the probe connects: up with no stats")
	assert.Equal(t, []string{statsScript, connectProbe}, *ran)
	assert.False(t, (&StatsBoard{cache: map[string]Stats{"remote:frontier": st}}).Closed("frontier", "remote"), "so it stays open to pool runs")

	b, _ = board(exit255, &RemoteExit{Code: 1})
	assert.Equal(t, NoStats, b.remoteStats("frontier").State, "a probe that ran and exited non-zero connected too")

	b, ran = board(exit255, exit255)
	assert.Equal(t, "unreachable", b.remoteStats("frontier").State, "neither connects: unreachable")
	assert.Len(t, *ran, 2)

	slow, slowRan := &StatsBoard{}, 0
	slow.Run = func(ctx context.Context, _, _ string) (string, error) {
		slowRan++
		<-ctx.Done()
		return "", ctx.Err()
	}
	if testing.Short() {
		t.Skip("the timeout case waits the read's 8 s")
	}
	assert.Equal(t, "unreachable", slow.remoteStats("frontier").State, "a read that timed out is unreachable")
	assert.Equal(t, 1, slowRan, "and is not probed again")
}
