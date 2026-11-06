//go:build !windows

package minilock

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #13787: mini-lock is retired: the mini is gated by Coral's queue. 'acquire' refuses (exit 3) and says what to do; 'release' and 'status' still reach the old script so a stale lock folder can be cleared.

func setup(t *testing.T) (home, script string) {
	t.Helper()
	home = t.TempDir()
	bin := filepath.Join(home, "coral-test", "bin")
	require.NoError(t, os.MkdirAll(bin, 0o755))
	src, err := filepath.Abs("../../../tools/heavy/mini-lock.sh")
	require.NoError(t, err)
	raw, err := os.ReadFile(src)
	require.NoError(t, err)
	script = filepath.Join(bin, "mini-lock")
	require.NoError(t, os.WriteFile(script, raw, 0o755))
	old := "#!/bin/bash\nLOCK=\"$HOME/coral-test/.heavy.lock\"\ncase \"${1:-status}\" in\n  status) if [ -d \"$LOCK\" ]; then echo \"held by '$(cat \"$LOCK/owner\")'\"; else echo free; fi ;;\n  release) rm -rf \"$LOCK\" && echo \"lock released\" ;;\n  acquire) mkdir \"$LOCK\" && echo taken ;;\nesac\n"
	require.NoError(t, os.WriteFile(filepath.Join(bin, "mini-lock.retired"), []byte(old), 0o755))
	return home, script
}

func run(t *testing.T, home, script string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command("bash", append([]string{script}, args...)...)
	cmd.Env = []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")}
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return string(out), code
}

func TestAcquireRefusesAndPointsToTheQueueAndTakesNoLock(t *testing.T) {
	home, script := setup(t)
	out, code := run(t, home, script, "acquire", "qa-engineer", "a flake run")
	assert.Equal(t, 3, code)
	assert.Contains(t, out, "coral-board resource claim mini --wait")
	assert.Contains(t, out, "coral-board resource release mini")
	_, err := os.Stat(filepath.Join(home, "coral-test", ".heavy.lock"))
	assert.True(t, os.IsNotExist(err), "no lock folder is made")
	out, code = run(t, home, script, "acquire")
	assert.Equal(t, 3, code, "whatever the arguments: "+out)
}

func TestReleaseAndStatusStillWorkSoAStaleLockCanBeCleared(t *testing.T) {
	home, script := setup(t)
	lock := filepath.Join(home, "coral-test", ".heavy.lock")
	require.NoError(t, os.MkdirAll(lock, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(lock, "owner"), []byte("someone"), 0o644))
	out, code := run(t, home, script, "status")
	assert.Equal(t, 0, code)
	assert.Contains(t, out, "someone")
	out, code = run(t, home, script, "release", "someone")
	assert.Equal(t, 0, code, out)
	_, err := os.Stat(lock)
	assert.True(t, os.IsNotExist(err), "the stale lock is cleared")
	out, _ = run(t, home, script)
	assert.True(t, strings.Contains(out, "free") || strings.Contains(out, "queue"), out)
}
