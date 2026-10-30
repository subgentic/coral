package testtemp

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestUsePointsTheTempFolderAtANewFolderAndRemovesIt(t *testing.T) {
	before := map[string]string{}
	for _, k := range []string{"TMPDIR", "TMP", "TEMP", "GOTMPDIR", "HOME", "USERPROFILE", "CORAL_DATA_DIR", "GOCACHE", "GOPATH", "GOMODCACHE", "GOENV", Marker} {
		before[k] = os.Getenv(k)
	}
	t.Cleanup(func() {
		for k, v := range before {
			os.Setenv(k, v)
		}
	})
	cleanup := setup()
	dir := os.TempDir()
	require.NotEqual(t, before["TMP"], os.Getenv("TMP"))
	dir = filepath.Clean(dir)
	for _, k := range []string{"TMPDIR", "TMP", "TEMP", "GOTMPDIR"} {
		assert.Equal(t, os.Getenv("TMP"), os.Getenv(k), k)
	}
	root := filepath.Dir(dir)
	assert.Equal(t, filepath.Join(root, "home"), os.Getenv("HOME"))
	assert.Equal(t, filepath.Join(root, "home"), os.Getenv("USERPROFILE"))
	assert.Equal(t, filepath.Join(root, "coral-data"), os.Getenv("CORAL_DATA_DIR"))
	home, err := os.UserHomeDir()
	require.NoError(t, err)
	assert.Equal(t, filepath.Join(root, "home"), home, "no test reaches the person's real home or ~/.coral")
	assert.NotEmpty(t, os.Getenv("GOCACHE"), "the Go tool keeps its build cache, so a test that builds is not cold")
	out, err := exec.Command("go", "env", "GOCACHE", "GOPATH", "GOMODCACHE").Output()
	require.NoError(t, err)
	want := strings.Fields(string(out)) // what go itself answers inside the private home: the same places as before
	require.Len(t, want, 3)
	assert.Equal(t, want[0], os.Getenv("GOCACHE"))
	assert.Equal(t, want[1], os.Getenv("GOPATH"))
	assert.Equal(t, want[2], os.Getenv("GOMODCACHE"))
	f, err := os.CreateTemp("", "x")
	require.NoError(t, err)
	f.Close()
	assert.Equal(t, filepath.Clean(dir), filepath.Dir(f.Name()), "new temp files land in the private folder")
	cleanup()
	_, err = os.Stat(root)
	assert.True(t, os.IsNotExist(err), "the folder is removed")
}

// A helper child (the test binary re-run with just -test.run=...) is not the process `go test` started: it keeps the environment its parent gave it.
func TestOnlyTheProcessGoTestStartedGetsAPrivateWorld(t *testing.T) {
	assert.True(t, startedByGoTest([]string{"x.test.exe", "-test.paniconexit0", "-test.timeout=10m0s", "-test.count=1"}))
	assert.True(t, startedByGoTest([]string{"x.test.exe", "-test.paniconexit0=true"}))
	assert.False(t, startedByGoTest([]string{"x.test.exe", "-test.paniconexit0=false"}))
	assert.False(t, startedByGoTest([]string{"x.test.exe", "-test.run=^TestHelperRunBoard$"}), "a helper child")
	assert.False(t, startedByGoTest([]string{"x.test.exe"}))
	assert.False(t, startedByGoTest(nil))
}

// TestHelperUse is the child: it calls Use the way a generated TestMain does and says what environment it ends up with.
func TestHelperUse(t *testing.T) {
	if os.Getenv("TESTTEMP_HELPER") != "1" {
		t.Skip("run by TestAHelperChildKeepsTheEnvironmentItsParentGaveIt")
	}
	cleanup := Use()
	defer cleanup()
	fmt.Printf("RESULT data=%s home=%s\n", os.Getenv("CORAL_DATA_DIR"), os.Getenv("HOME"))
}

// The way coral-board's runBoardInput runs its helper: the test binary again, with only -test.run, an environment filtered of CORAL_*, TMUX* and HOME and then given explicit values.
// The child's Use must leave those values alone (QA's cause of #177's failures); the same child started with go test's flag and no marker would be changed.
func TestAHelperChildKeepsTheEnvironmentItsParentGaveIt(t *testing.T) {
	data, home := t.TempDir(), t.TempDir()
	run := func(extraArg string, env ...string) string {
		args := []string{"-test.run=^TestHelperUse$", "-test.v"}
		if extraArg != "" {
			args = append(args, extraArg)
		}
		cmd := exec.Command(os.Args[0], args...)
		for _, kv := range os.Environ() {
			if !strings.HasPrefix(kv, "CORAL_") && !strings.HasPrefix(kv, "TMUX") && !strings.HasPrefix(kv, "HOME=") && !strings.HasPrefix(kv, Marker+"=") { // this test process has the marker itself (its TestMain); a case sets it explicitly
				cmd.Env = append(cmd.Env, kv)
			}
		}
		cmd.Env = append(cmd.Env, "TESTTEMP_HELPER=1", "CORAL_DATA_DIR="+data, "HOME="+home)
		cmd.Env = append(cmd.Env, env...)
		out, err := cmd.CombinedOutput()
		require.NoError(t, err, string(out))
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(l, "RESULT ") {
				return strings.TrimSpace(l)
			}
		}
		t.Fatalf("no result in %s", out)
		return ""
	}
	want := fmt.Sprintf("RESULT data=%s home=%s", data, home)
	assert.Equal(t, want, run(""), "a helper child, as runBoardInput starts it, keeps what its parent passed")
	// Even a child that has go test's flag keeps it when the marker came through.
	assert.Equal(t, want, run("-test.paniconexit0", Marker+"=/somewhere"), "the marker stops a second private world")
	// Without the marker, a process go test started does make its own: the values differ.
	assert.NotEqual(t, want, run("-test.paniconexit0"), "a top-level test process gets its own")
}
