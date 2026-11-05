package testguard

import (
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// The macOS release's Go cache restore is tried once more when the first restore found nothing, and the go.sum check after it is as strict as before
// (.github/actions/setup-go-macos, v2.0.52's ETIMEDOUT). The check is tests/release/setup_go_macos_retry_test.sh, which reads the action as text; this test runs it
// with every head's go test, so it needs no line in a workflow file. Windows has no bash and no python3 the script can rely on: it is a Linux and macOS release check.
func TestTheMacOSGoCacheRetryAndItsUnchangedModuleCheck(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a Linux and macOS release check: the script needs bash and python3")
	}
	for _, tool := range []string{"bash", "python3"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("no %s", tool)
		}
	}
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "tests", "release", "setup_go_macos_retry_test.sh"))
	require.NoError(t, err)
	require.FileExists(t, script)
	cmd := exec.Command("bash", script)
	done := make(chan struct{})
	var out []byte
	go func() { out, err = cmd.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("the cache retry check took longer than 30 s")
	}
	require.NoError(t, err, "%s", out)
	require.True(t, strings.Contains(string(out), "PASS setup_go_macos_retry"), "%s", out)
}
