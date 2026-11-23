package agent

import (
	"os"
	"testing"
)

// tmpDir is t.TempDir() with a mode of its own: the folder is made with the umask applied (0775 under 0002, which names the group as a writer of the node path), so the tests chmod it and pass under any umask (#20036). It has no build tag: the Hermes rig uses it on Windows too (#20744).
func tmpDir(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	if err := os.Chmod(d, 0o755); err != nil {
		t.Fatal(err)
	}
	return d
}
