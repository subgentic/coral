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
	st := b.Get("Epoch", "remote")
	require.NotNil(t, st)
	assert.Equal(t, "ok", st.State)
	assert.Equal(t, "epoch", gotAlias, "the machine's name as an ssh host, nothing else")
	assert.Equal(t, statsScript, gotScript, "the command is the fixed one: no text from a description or an agent")
	assert.False(t, strings.ContainsAny(gotScript, "$`\\"), "and it has no substitution")
	b.Get("Epoch", "remote")
	b.Get("Epoch", "remote")
	assert.Equal(t, int32(1), calls.Load(), "three looks inside the minute are one ssh call")

	down := &StatsBoard{Run: func(context.Context, string, string) (string, error) { return "", errors.New("timed out") }}
	assert.Equal(t, "unreachable", down.Get("mini", "remote").State)
	assert.Contains(t, down.Get("mini", "remote").Words(), "unreachable")

	assert.Nil(t, b.Get("Epoch", ""), "a resource that does not say where it is has no stats")
	assert.Equal(t, "unavailable", (&StatsBoard{Run: b.Run}).Get("!!!", "remote").State, "a name with no host in it is never passed to ssh")
	var seen string
	odd := &StatsBoard{Run: func(_ context.Context, alias, _ string) (string, error) { seen = alias; return linuxOut, nil }}
	odd.Get("-oProxyCommand=x; rm -rf /", "remote")
	assert.Equal(t, "oproxycommand-x-rm-rf", seen, "any other name becomes a plain slug that cannot be an ssh option")
	assert.Equal(t, "ok", (&StatsBoard{}).Get("here", "here").State, "this machine is read directly")
}
