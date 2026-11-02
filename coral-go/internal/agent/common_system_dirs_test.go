package agent

import (
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The folders outside home are a seam, so a test of "nothing is installed" does not depend on the machine it runs on (#12423).
func TestCommonSystemBinDirsAreOwnedByTheTest(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("the system folders are the Unix ones")
	}
	t.Setenv("HOME", t.TempDir())
	system := func() []string {
		var out []string
		for _, p := range CommonPlaceCandidates("zzcli") {
			if d := filepath.Dir(p); d == "/usr/local/bin" || d == "/opt/homebrew/bin" || d == "/snap/bin" {
				out = append(out, p)
			}
		}
		return out
	}
	assert.Contains(t, system(), "/usr/local/bin/zzcli", "by default the system folders are searched")
	prev := CommonSystemBinDirs
	t.Cleanup(func() { CommonSystemBinDirs = prev })
	CommonSystemBinDirs = func() []string { return nil }
	assert.Empty(t, system(), "a test that empties them sees none of them")
	CommonSystemBinDirs = func() []string { return []string{"/usr/local/bin"} }
	assert.Equal(t, []string{"/usr/local/bin/zzcli"}, system(), "and one that lists a folder sees that one")
}
