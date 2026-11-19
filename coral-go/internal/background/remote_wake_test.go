package background

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// resetCounter is a resolver that keeps connections of its own, as an ssh server's stream target does: it counts the times the hub asked it to drop them.
type resetCounter struct {
	rowResolver
	mu    sync.Mutex
	reset map[string]int
}

func (r *resetCounter) ResetConnections(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reset == nil {
		r.reset = map[string]int{}
	}
	r.reset[id]++
}

func (r *resetCounter) resets(id string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reset[id]
}

// #19885 (the Operator: a self-hosted hub's remotes stayed "not running" after the hub's Mac slept and woke): a Reconnect drops the resolver's own connections too, not only the proxy's pooled ones, so an
// ssh server's half-dead streams are not reused.
func TestHub_ReconnectDropsTheResolversOwnConnections(t *testing.T) {
	a := newFakeRemote(t, sess("one", "a-1"))
	a.noFeed = true
	reg := newRowRegistry()
	reg.put("a", a.URL)
	res := &resetCounter{rowResolver: rowResolver{reg}}
	h := NewRemoteAgentHub(reg, res, RemoteAgentHubConfig{PollInterval: 30 * time.Second, RequestTimeout: 300 * time.Millisecond,
		RegistryRefresh: time.Hour, MinBackoff: 20 * time.Millisecond, MaxBackoff: 100 * time.Millisecond, OfflineGrace: -1})
	startHub(t, h)
	require.Eventually(t, onlineEverywhere(h, reg, "a"), 3*time.Second, 10*time.Millisecond)
	h.Reconnect("a")
	assert.Equal(t, 1, res.resets("a"))
}

// A gap in the hub's wall clock (the computer slept; its monotonic clock stood still, so timers and idle-connection ages did not notice) dials every remote again at once: the resolver drops its connections
// and the worker probes again, with no click and no restart. A look with no gap does nothing.
func TestHub_AWakeFromSleepDialsEveryRemoteAgain(t *testing.T) {
	a := newFakeRemote(t, sess("one", "a-1"))
	a.noFeed = true
	reg := newRowRegistry()
	reg.put("a", a.URL)
	res := &resetCounter{rowResolver: rowResolver{reg}}
	old := wakeLook
	wakeLook = 10 * time.Millisecond
	t.Cleanup(func() { wakeLook = old })
	var skew atomic.Int64 // nanoseconds the wall clock was moved on by the "sleep"
	h := NewRemoteAgentHub(reg, res, RemoteAgentHubConfig{PollInterval: 30 * time.Second, RequestTimeout: 300 * time.Millisecond,
		RegistryRefresh: time.Hour, MinBackoff: 20 * time.Millisecond, MaxBackoff: 100 * time.Millisecond, OfflineGrace: -1, WakeGap: time.Minute})
	h.wall = func() time.Time { return time.Now().Add(time.Duration(skew.Load())).Round(0) }
	startHub(t, h)
	require.Eventually(t, onlineEverywhere(h, reg, "a"), 3*time.Second, 10*time.Millisecond)
	time.Sleep(100 * time.Millisecond) // sleep-ok: several looks with no gap
	assert.Equal(t, 0, res.resets("a"), "no sleep, no reconnect")
	before, _ := a.counts()

	skew.Store(int64(10 * time.Hour)) // the lid was closed
	require.Eventually(t, func() bool { return res.resets("a") == 1 }, 2*time.Second, 10*time.Millisecond, "the resolver's connections are dropped once")
	require.Eventually(t, func() bool { n, _ := a.counts(); return n > before }, 2*time.Second, 10*time.Millisecond, "and the remote is probed again at once, not on the poll schedule")
	time.Sleep(100 * time.Millisecond) // sleep-ok: more looks, the same skew: no second wake
	assert.Equal(t, 1, res.resets("a"), "one sleep is one reconnect")
	require.Eventually(t, onlineEverywhere(h, reg, "a"), 3*time.Second, 10*time.Millisecond)
}
