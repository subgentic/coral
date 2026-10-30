// Package netbindtest gates the tests that listen on a wildcard or network address. On Windows the first listen on every interface makes
// Windows Firewall ask, on the person's desktop, whether to allow the test binary, and a go test builds a new binary path each time: so
// those tests run on Windows only on CI (a runner has no person to ask) or when CORAL_TEST_NETWORK_BIND=1 is set. Everywhere else they run.
package netbindtest

import (
	"os"
	"runtime"
	"testing"
)

// Allowed says whether a test may listen on a wildcard or a network address here.
func Allowed() bool { return allowed(runtime.GOOS, os.Getenv) }

func allowed(goos string, getenv func(string) string) bool {
	return goos != "windows" || getenv("CI") != "" || getenv("CORAL_TEST_NETWORK_BIND") == "1"
}

// Require skips the test where Allowed is false.
func Require(t testing.TB) {
	t.Helper()
	if !Allowed() {
		t.Skip("listens on a wildcard or network address, which makes Windows Firewall ask about the test binary on the desktop: set CORAL_TEST_NETWORK_BIND=1 to run it (CI runs it)")
	}
}
