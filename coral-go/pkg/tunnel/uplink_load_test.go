package tunnel

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// hostLoad is the host's 1-minute load average and whether it could be read: /proc/loadavg on Linux, `sysctl -n vm.loadavg` on macOS, neither
// on Windows. A variable so a test can stub it.
var hostLoad = readHostLoad

func readHostLoad() (float64, bool) {
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		return parseLoad(string(b))
	}
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("sysctl", "-n", "vm.loadavg").Output(); err == nil {
			return parseLoad(string(out))
		}
	}
	return 0, false
}

// parseLoad reads the first (1-minute) figure of "0.52 0.58 0.59 1/467 12345" (Linux) or "{ 3.21 2.98 2.77 }" (macOS).
func parseLoad(s string) (float64, bool) {
	f := strings.Fields(strings.NewReplacer("{", " ", "}", " ").Replace(s))
	if len(f) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil || v < 0 {
		return 0, false
	}
	return v, true
}

// loadavg is the host's 1-minute load average for the log, "n/a" where it cannot be read.
func loadavg() string {
	if l, ok := hostLoad(); ok {
		return fmt.Sprintf("%.2f", l)
	}
	return "n/a"
}

// criterionFor is the absolute small-reply p95 bound for a host: coral-hub's 200 ms when the machine is quiet, windowsCriterion on Windows
// or when the load is unreadable or above the core count (other packages' tests running at once eat the ~30 ms of headroom; a Mac run
// beside the board, server and routes tests measured a median p95 of 206 ms, #14561). The second result says why a looser bound applied.
func criterionFor(goos string, load float64, loadOK bool, cpus int) (time.Duration, string) {
	switch {
	case goos == "windows":
		return windowsCriterion, "the shared Windows runners pace the link unevenly"
	case !loadOK:
		return windowsCriterion, "the load average could not be read"
	case load > float64(cpus):
		return windowsCriterion, fmt.Sprintf("load average %.2f is above the %d cores", load, cpus)
	}
	return hubCriterion, ""
}

// smallReplyCriterion is the bound for this host, with the load as it is now.
func smallReplyCriterion() (time.Duration, string) {
	load, ok := hostLoad()
	return criterionFor(runtime.GOOS, load, ok, runtime.NumCPU())
}

func TestParseLoadReadsTheOneMinuteFigure(t *testing.T) {
	for in, want := range map[string]float64{
		"0.52 0.58 0.59 1/467 12345\n": 0.52,
		"{ 3.21 2.98 2.77 }\n":         3.21,
		"{ 12.5 9.1 4.0 }":             12.5,
	} {
		got, ok := parseLoad(in)
		assert.True(t, ok, in)
		assert.InDelta(t, want, got, 0.001, in)
	}
	for _, bad := range []string{"", "   ", "{ }", "n/a", "{ x y z }", "-1 0 0"} {
		_, ok := parseLoad(bad)
		assert.False(t, ok, "%q", bad)
	}
}

func TestSmallReplyCriterionFollowsTheLoad(t *testing.T) {
	for _, c := range []struct {
		name   string
		goos   string
		load   float64
		ok     bool
		cpus   int
		want   time.Duration
		reason string
	}{
		{"quiet mac", "darwin", 2.0, true, 8, hubCriterion, ""},
		{"quiet linux", "linux", 0.5, true, 4, hubCriterion, ""},
		{"exactly the core count is still quiet", "darwin", 8.0, true, 8, hubCriterion, ""},
		{"busy mac (UI/UX's U6 run: three packages at once)", "darwin", 11.3, true, 8, windowsCriterion, "above the 8 cores"},
		{"busy linux", "linux", 30, true, 4, windowsCriterion, "above the 4 cores"},
		{"load unreadable", "darwin", 0, false, 8, windowsCriterion, "could not be read"},
		{"windows is always the looser bound", "windows", 0, true, 8, windowsCriterion, "Windows"},
	} {
		got, why := criterionFor(c.goos, c.load, c.ok, c.cpus)
		assert.Equal(t, c.want, got, c.name)
		if c.reason == "" {
			assert.Empty(t, why, c.name)
		} else {
			assert.Contains(t, why, c.reason, c.name)
		}
	}
}

func TestSmallReplyCriterionReadsTheStubbedHostLoad(t *testing.T) {
	defer func(old func() (float64, bool)) { hostLoad = old }(hostLoad)
	cpus := float64(runtime.NumCPU())
	hostLoad = func() (float64, bool) { return cpus + 1, true }
	got, why := smallReplyCriterion()
	if runtime.GOOS != "windows" {
		assert.Contains(t, why, "above the")
	}
	assert.Equal(t, windowsCriterion, got)
	hostLoad = func() (float64, bool) { return 0, true }
	got, _ = smallReplyCriterion()
	if runtime.GOOS != "windows" {
		assert.Equal(t, hubCriterion, got)
	}
	assert.NotEmpty(t, loadavg())
	hostLoad = func() (float64, bool) { return 0, false }
	assert.Equal(t, "n/a", loadavg())
}

func TestTheHostLoadIsReadableHere(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no load average")
	}
	l, ok := readHostLoad()
	assert.True(t, ok, "the load average must be readable on Linux and macOS, or the looser bound applies every time")
	assert.GreaterOrEqual(t, l, 0.0)
}
