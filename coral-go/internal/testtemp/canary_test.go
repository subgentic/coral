package testtemp

import (
	"flag"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The canary (Security and the Orchestrator, #177): testtemp makes the private world only in a process that has go test's -test.paniconexit0. If a future Go stops passing the flag, every
// package would silently run in the real temp, home and ~/.coral; this test runs in every go test, and fails unless the flag exists and is true AND this process (whose TestMain calls Run,
// like every package's) really got its private world. TESTTEMP_DIRECT=1 skips it for a test binary run directly, not by go test or the shard script.
func TestPrivateWorldIsOn(t *testing.T) {
	if os.Getenv("TESTTEMP_DIRECT") == "1" {
		t.Skip("run directly, not by go test")
	}
	f := flag.Lookup("test.paniconexit0")
	require.NotNil(t, f, "go test no longer passes -test.paniconexit0: the private test world is OFF")
	require.Equal(t, "true", f.Value.String(), "go test no longer passes -test.paniconexit0=true: the private test world is OFF")
	require.True(t, startedByGoTest(os.Args), "the arguments no longer show go test's flag (%v): the private test world is OFF", os.Args)
	require.NotEmpty(t, os.Getenv(Marker), "this process has no private world although its TestMain calls Run: the private test world is OFF")
	require.Equal(t, os.Getenv("TMP"), os.TempDir(), "the temp folder is not the private one")
}
