package machinehealth

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const gb = 1 << 30

func healthy() Health {
	return Health{
		Host: Host{Load1PerCore: 0.3, CPUCount: 8, MemTotal: 16 * gb, MemAvailable: 8 * gb},
		Disk: Disk{FreeBytes: 200 * gb, TotalBytes: 500 * gb},
	}
}

// The operator's thresholds, and which reason wins when several apply.
func TestClassify(t *testing.T) {
	now := time.Now()
	fast := Responsiveness{Last: 20 * time.Millisecond, P95: 40 * time.Millisecond}
	with := func(f func(*Health)) Health { h := healthy(); f(&h); return h }
	for _, tc := range []struct {
		name           string
		h              Health
		r              Responsiveness
		haveR          bool
		status, reason string
	}{
		{"all fine", healthy(), fast, true, "ok", ""},
		{"no watchdog, all fine", healthy(), Responsiveness{}, false, "ok", ""},
		{"high load per core alone is not busy", with(func(h *Health) { h.Host.Load1PerCore = 9 }), fast, true, "ok", ""},
		{"high load per core with no watchdog is not busy", with(func(h *Health) { h.Host.Load1PerCore = 9 }), Responsiveness{}, false, "ok", ""},
		{"probe p95 exactly 500 ms", healthy(), Responsiveness{Last: 100 * time.Millisecond, P95: 500 * time.Millisecond}, true, "ok", ""},
		{"probe p95 over 500 ms", healthy(), Responsiveness{Last: 100 * time.Millisecond, P95: 600 * time.Millisecond}, true, "busy", "cpu"},
		{"memory under 10%", with(func(h *Health) { h.Host.MemAvailable = gb }), fast, true, "busy", "memory"},
		{"disk under 5%", with(func(h *Health) { h.Disk = Disk{FreeBytes: 20 * gb, TotalBytes: 500 * gb} }), fast, true, "busy", "disk"},
		{"disk under 2 GB", with(func(h *Health) { h.Disk = Disk{FreeBytes: gb, TotalBytes: 10 * gb} }), fast, true, "busy", "disk"},
		{"last probe over 2 s", healthy(), Responsiveness{Last: 2500 * time.Millisecond}, true, "stalled", "stall"},
		{"a stall 30 s ago", healthy(), Responsiveness{Last: 20 * time.Millisecond, LastSlow: now.Add(-30 * time.Second)}, true, "stalled", "stall"},
		{"a stall 90 s ago is over", healthy(), Responsiveness{Last: 20 * time.Millisecond, LastSlow: now.Add(-90 * time.Second)}, true, "ok", ""},
		{"stall beats disk, memory and cpu", with(func(h *Health) { h.Disk.FreeBytes = gb; h.Host.MemAvailable = 0; h.Host.Load1PerCore = 9 }), Responsiveness{Last: 3 * time.Second}, true, "stalled", "stall"},
		{"disk beats memory and cpu", with(func(h *Health) { h.Disk.FreeBytes = gb; h.Host.MemAvailable = 0; h.Host.Load1PerCore = 9 }), fast, true, "busy", "disk"},
		{"memory beats cpu", with(func(h *Health) { h.Host.MemAvailable = 0 }), Responsiveness{Last: 100 * time.Millisecond, P95: 600 * time.Millisecond}, true, "busy", "memory"},
		{"unknown memory and disk do not count", with(func(h *Health) { h.Host.MemTotal = 0; h.Disk = Disk{} }), fast, true, "ok", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, reason := classify(tc.h, tc.r, tc.haveR, now)
			assert.Equal(t, tc.status, status)
			assert.Equal(t, tc.reason, reason)
		})
	}
}

// A real sample: sane values, and an agent's child process is counted.
func TestSampleReadsTheMachine(t *testing.T) {
	agent := exec.Command("sleep", "30")
	require.NoError(t, agent.Start())
	t.Cleanup(func() { agent.Process.Kill(); agent.Wait() })

	s := New(Source{
		DataDir:    t.TempDir(),
		AgentPIDs:  func() []int { return []int{agent.Process.Pid} },
		AgentCount: func() int { return 1 },
		Responsive: func() (Responsiveness, bool) {
			return Responsiveness{Last: 12 * time.Millisecond, P95: 30 * time.Millisecond}, true
		},
	})
	_, ok := s.Current()
	assert.False(t, ok, "nothing before the first sample")
	ctx := context.Background()
	s.Sample(ctx)
	busy := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(busy) { // some CPU for Coral's own share
	}
	h := s.Sample(ctx)
	cur, ok := s.Current()
	require.True(t, ok)
	assert.Equal(t, h, cur)

	assert.Contains(t, []string{"ok", "busy", "stalled"}, h.Status)
	if h.Status == "ok" {
		assert.Empty(t, h.Reason)
	} else {
		assert.Contains(t, []string{"cpu", "memory", "disk", "stall"}, h.Reason)
	}
	assert.EqualValues(t, 12, h.ResponsivenessMS)
	assert.Greater(t, h.Coral.RSSBytes, uint64(0), "Coral's resident memory")
	assert.Greater(t, h.Coral.CPUPercent, 0.0, "Coral used CPU over the interval")
	assert.Equal(t, 1, h.Agents.Count)
	assert.Greater(t, h.Agents.RSSBytes, uint64(0), "the agent's process is counted")
	assert.GreaterOrEqual(t, h.Agents.CPUPercent, 0.0)
	assert.Greater(t, h.Host.CPUCount, 0)
	assert.Greater(t, h.Host.MemTotal, uint64(0))
	assert.LessOrEqual(t, h.Host.MemAvailable, h.Host.MemTotal)
	assert.GreaterOrEqual(t, h.Host.Load1PerCore, 0.0)
	assert.Greater(t, h.Disk.TotalBytes, uint64(0))
	assert.LessOrEqual(t, h.Disk.FreeBytes, h.Disk.TotalBytes)
}

// Numbers only (#3444): the JSON carries no string but the two enums, and exactly the agreed keys.
func TestHealthJSONIsNumbersOnly(t *testing.T) {
	s := New(Source{DataDir: t.TempDir(), AgentPIDs: func() []int { return nil }, AgentCount: func() int { return 0 }})
	h := s.Sample(context.Background())
	h.Status, h.Reason = "busy", "disk" // both enums present
	b, err := json.Marshal(h)
	require.NoError(t, err)
	var m map[string]any
	require.NoError(t, json.Unmarshal(b, &m))

	var keys []string
	var walk func(prefix string, v any)
	walk = func(prefix string, v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, vv := range x {
				walk(prefix+k+".", vv)
			}
		case string:
			keys = append(keys, prefix)
			switch prefix {
			case "status.":
				assert.Contains(t, []string{"ok", "busy", "stalled"}, x)
			case "reason.":
				assert.Contains(t, []string{"cpu", "memory", "disk", "stall"}, x)
			default:
				t.Errorf("a string at %s: %q", prefix, x)
			}
		case float64:
			keys = append(keys, prefix)
		default:
			t.Errorf("unexpected %T at %s", v, prefix)
		}
	}
	walk("", m)
	sort.Strings(keys)
	assert.Equal(t, []string{
		"agents.count.", "agents.cpu_percent.", "agents.rss_bytes.",
		"coral.cpu_percent.", "coral.rss_bytes.",
		"disk.free_bytes.", "disk.total_bytes.",
		"host.cpu_count.", "host.load1_per_core.", "host.mem_available.", "host.mem_total.",
		"reason.", "responsiveness_ms.", "status.",
	}, keys, "the agreed schema, nothing more")
}

// busy_by names the others only when the busy is on cpu, this sample measured Coral's and the agents' CPU, and they used under a tenth of the host's cores (#10887).
func TestBusyBy(t *testing.T) {
	busy := func(coral, agents float64, cpus int, measured bool) Health {
		return Health{Status: "busy", Reason: "cpu", Coral: Proc{CPUPercent: coral}, Agents: Agents{CPUPercent: agents}, Host: Host{CPUCount: cpus}, cpuMeasured: measured}
	}
	for _, tc := range []struct {
		name string
		h    Health
		want string
	}{
		{"idle Coral on a busy computer", busy(0.5, 0, 8, true), "others"},
		{"just under a tenth of the cores", busy(30, 49, 8, true), "others"}, // 79% of 800%
		{"a tenth of the cores or more is nobody's to name", busy(40, 40, 8, true), ""},
		{"the agents are the load", busy(3, 400, 8, true), ""},
		{"no CPU reading yet: not known", busy(0, 0, 8, false), ""},
		{"no core count: not known", busy(0, 0, 0, true), ""},
		{"memory busy is not about the processor", Health{Status: "busy", Reason: "memory", cpuMeasured: true, Host: Host{CPUCount: 8}}, ""},
		{"ok has no one to name", Health{Status: "ok", cpuMeasured: true, Host: Host{CPUCount: 8}}, ""},
		{"stalled has no one to name", Health{Status: "stalled", Reason: "stall", cpuMeasured: true, Host: Host{CPUCount: 8}}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) { assert.Equal(t, tc.want, busyBy(tc.h)) })
	}
}

// A CPU figure is a reading only when it was read: a read that fails leaves 0 behind, which would say "uses nothing" and blame a busy cpu on other programs (#10887, QA Reviewer 2).
func TestCPUMeasured(t *testing.T) {
	for _, tc := range []struct {
		name                       string
		haveInterval, selfMeasured bool
		roots, agentsRead          int
		want                       bool
	}{
		{"Coral and no agents, both read", true, true, 0, 0, true},
		{"Coral and agents, both read", true, true, 3, 2, true},
		{"the first sample has nothing to compare with", false, true, 0, 0, false},
		{"Coral's own read failed", true, false, 0, 0, false},
		{"Coral's own read failed, agents read", true, false, 3, 3, false},
		{"agents present but none could be read", true, true, 3, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, cpuMeasured(tc.haveInterval, tc.selfMeasured, tc.roots, tc.agentsRead))
		})
	}
}

// Through a real sampler: with an agent whose process cannot be read (it is not there), the second sample is not measured, so a busy cpu names nobody; with no agents it is.
func TestSampleNamesNobodyWhenTheAgentsCannotBeRead(t *testing.T) {
	ctx := context.Background()
	sample := func(roots []int) Health {
		s := New(Source{DataDir: t.TempDir(), AgentPIDs: func() []int { return roots }})
		s.Sample(ctx)
		time.Sleep(20 * time.Millisecond) // sleep-ok: the interval a CPU figure is read over
		h := s.Sample(ctx)
		h.Status, h.Reason = "busy", "cpu"
		return h
	}
	// What this test is about is whether the sample is a reading, not how much CPU the test binary happened to use in a 20 ms window: Windows counts a process's CPU in ticks of about 15.6 ms, so one tick in that
	// window is "78% of a core" and busyBy rightly stops naming the others (and a loaded Linux runner can do the same). The figures are set to idle after the sample; busyBy's own threshold is TestBusyBy's.
	idle := func(h Health) Health { h.Coral.CPUPercent, h.Agents.CPUPercent = 0, 0; return h }
	none := idle(sample(nil))
	assert.True(t, none.cpuMeasured, "no agents: the second sample is measured")
	assert.Equal(t, "others", busyBy(none), "and an idle Coral on a busy cpu names the others")
	gone := idle(sample([]int{2147483000})) // a process that is not there: nothing of it can be read
	assert.False(t, gone.cpuMeasured, "an agent that cannot be read: not measured")
	assert.Equal(t, "", busyBy(gone), "so nobody is named")
}

// One sample walks the process table once; at one sample per Interval (15 s) it must cost well
// under 1% of a core: a sample under 150 ms of CPU.
func BenchmarkSample(b *testing.B) {
	s := New(Source{DataDir: b.TempDir(), AgentPIDs: func() []int { return []int{1} }})
	ctx := context.Background()
	for i := 0; i < b.N; i++ {
		s.Sample(ctx)
	}
}

// treeHelperEnv makes this test binary a helper process: "parent" starts a "child" (the test
// binary again) and waits for it; "child" sleeps. Real parent links on every OS: on Windows,
// Git's sh started its background sleep through a short-lived MSYS stub, so the sleep's parent
// was sometimes already gone and the walk could not reach it (#4011).
const treeHelperEnv = "CORAL_MACHINEHEALTH_TREE_HELPER"

func init() {
	switch os.Getenv(treeHelperEnv) {
	case "parent":
		c := exec.Command(os.Args[0], "-test.run=^$")
		c.Env = append(os.Environ(), treeHelperEnv+"=child")
		if c.Start() == nil {
			_ = c.Wait()
		}
		os.Exit(0)
	case "child":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
}

// #3846: the walk finds a grandchild (a child's own child), from the cheap process table.
func TestDescendantsFindsGrandchildren(t *testing.T) {
	parent := exec.Command(os.Args[0], "-test.run=^$")
	parent.Env = append(os.Environ(), treeHelperEnv+"=parent")
	require.NoError(t, parent.Start())
	root := parent.Process.Pid
	var found []int32
	// The child too, not only the parent: the descendants found, by pid (#3997).
	t.Cleanup(func() {
		for _, pid := range found {
			if p, err := os.FindProcess(int(pid)); err == nil && int(pid) != root {
				_ = p.Kill()
			}
		}
		parent.Process.Kill()
		parent.Wait()
	})
	require.Eventually(t, func() bool {
		found = descendants(context.Background(), []int{root})
		return len(found) >= 2
	}, 5*time.Second, 20*time.Millisecond, "the helper and its child")
	assert.Equal(t, int32(root), found[0])
}

// #3846: with nobody reading, sampling pauses; a read of an old sample asks for a new one.
func TestSamplingPausesWhileNobodyReads(t *testing.T) {
	var mu sync.Mutex
	at := time.Unix(1_700_000_000, 0)
	s := New(Source{DataDir: t.TempDir()})
	s.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return at }
	advance := func(d time.Duration) { mu.Lock(); at = at.Add(d); mu.Unlock() }
	s.Sample(context.Background())
	_, _ = s.Current()
	assert.True(t, s.watched(), "just read")
	advance(IdleAfter + time.Second)
	assert.False(t, s.watched(), "nobody read for IdleAfter")
	select {
	case <-s.kick:
		t.Fatal("no request before a read")
	default:
	}
	_, ok := s.Current()
	require.True(t, ok, "the last sample is still given")
	select {
	case <-s.kick:
	default:
		t.Fatal("a read of an old sample asks for a new one")
	}
	assert.True(t, s.watched())
}
