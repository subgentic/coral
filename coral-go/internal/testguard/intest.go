package testguard

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
)

// InTest reports whether this process is a test binary, without importing the testing package: testing.Testing() would link the whole testing package into every shipped binary that imports
// testguard (or anything that asks it), and the package-init scrub in env.go has to ask before testing.Init has registered its flags. So it looks at what go test leaves: the binary is named
// "<package>.test" (".test.exe" on Windows), it is started with -test.* flags, or the test flags are already registered. A shipped binary normally has none of these, but a
// shipped binary that its launcher starts with a -test.* argument counts as one here (#10014): InTest is only for the package-init scrub (#9980), and the checks that act
// on what a test does use InTestRun. A test binary built with
// "go test -c -o other-name" and run by hand with no flags is not recognised: the guards then do nothing there, as they do in a shipped binary.
// InTestRun reports whether the test flags are registered: only a running test binary has them (go test's generated main calls testing.Init before any test, TestMain included). Unlike InTest it does not
// trust the binary's name or its arguments, which a launcher of a shipped binary controls, so it is the check for anything that acts on a test-only environment variable (dbcrypt's fault injection);
// InTest is for the package-init scrub in env.go, which runs before the flags are registered.
func InTestRun() bool { return flag.Lookup("test.v") != nil }

func InTest() bool { return inTest(os.Args, flag.Lookup("test.v") != nil) }

func inTest(args []string, testFlagsRegistered bool) bool {
	if len(args) > 0 {
		if b := filepath.Base(args[0]); strings.HasSuffix(b, ".test") || strings.HasSuffix(b, ".test.exe") {
			return true
		}
		for _, a := range args[1:] {
			if strings.HasPrefix(a, "-test.") {
				return true
			}
		}
	}
	return testFlagsRegistered
}
