package machineprobe

import (
	"os/exec"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const linuxAnswer = "os=linux\narch=x86_64\ncores=48\nmem_mb=128000\ndisk_gb=900\ngo=go version go1.26.1 linux/amd64\nnode=\n\nprobe-end\n"

// A machine's answer becomes its facts, slots and weight (#17588).
func TestAProbeBecomesFactsSlotsAndWeight(t *testing.T) {
	p, err := Parse(linuxAnswer)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"os": "linux", "arch": "x86_64", "cores": "48", "memory_gb": "125", "go": "1.26"}, p.Facts(), "no node and no Chrome: no such facts, so a need for them is never met")
	assert.Equal(t, 4, p.Slots(), "never more than 4")
	assert.Equal(t, 48, p.Weight())
	small, err := Parse("os=darwin\narch=arm64\ncores=8\nmem_mb=16384\ndisk_gb=100\ngo=go version go1.25.0 darwin/arm64\nnode=v22.3.1\nchrome=yes\nprobe-end")
	require.NoError(t, err)
	assert.Equal(t, 2, small.Slots())
	assert.Equal(t, map[string]string{"os": "darwin", "arch": "arm64", "cores": "8", "memory_gb": "16", "go": "1.25", "node": "22", "chrome": "yes"}, small.Facts())
	tiny, err := Parse("os=linux\narch=arm64\ncores=2\nmem_mb=1024\ndisk_gb=5\nprobe-end")
	require.NoError(t, err)
	assert.Equal(t, 1, tiny.Slots(), "at least 1")
	assert.Contains(t, tiny.Description("pi", false), "no Go, node or Chrome found")
}

func TestAnAnswerThatIsCutShortOrNotAUnixBoxIsRefusedWithAReason(t *testing.T) {
	_, err := Parse("os=linux\ncores=4\n")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cut short")
	_, err = Parse("os=\ncores=\nprobe-end\n")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Windows")
	_, err = Parse("os=linux\ncores=zero\nprobe-end\n")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "cores")
}

// The real script, run here, gives an answer Parse accepts, and reads nothing it should not: it only prints the eight keys.
func TestTheScriptRunsHereAndParses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the probe script is for Unix machines; a Windows box is defined by hand (resource define)")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	out, err := exec.Command("sh", "-c", Script).Output()
	require.NoError(t, err)
	p, err := Parse(string(out))
	require.NoError(t, err, string(out))
	assert.NotEmpty(t, p.OS)
	assert.Greater(t, p.Cores, 0)
	assert.NotEmpty(t, p.Description("here", true))
}
