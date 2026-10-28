package testguard

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInTest(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		flags bool
		want  bool
	}{
		{"this very test binary", nil, true, true},
		{"go test names the binary pkg.test", []string{"/tmp/go-build123/b001/routes.test"}, false, true},
		{"on Windows", []string{`C:\Temp\go-build\b001\routes.test.exe`}, false, true},
		{"started with test flags", []string{"/tmp/x/renamed", "-test.timeout=10m0s", "-test.v=true"}, false, true},
		{"the shipped coral", []string{"/usr/local/bin/coral", "--port", "8420"}, false, false},
		{"the shipped coral-board", []string{"coral-board", "read"}, false, false},
		{"no arguments at all", nil, false, false},
		{"a name that only contains .test", []string{"/opt/my.tests/coral"}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, inTest(tc.args, tc.flags))
		})
	}
	assert.True(t, InTest(), "a test binary says so")
	assert.True(t, InTestRun(), "and its test flags are registered while a test runs")
}

// #9980: the testing package is not linked into the binaries Coral ships. testguard and what asks it whether this is a test must not import it (testing.Testing() would): a shipped binary carries
// the whole test framework and its flags otherwise. coral-update is left out: a certificate library it uses (pkcs7) imports testing in its own non-test code.
func TestShippedBinariesDoNotLinkTesting(t *testing.T) {
	if testing.Short() {
		t.Skip("runs go list")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command to ask")
	}
	for _, pkg := range []string{"coral", "coral-board", "coral-agent", "launch-coral", "coral-hook-agentic-state", "coral-hook-message-check", "coral-hook-session-start", "coral-hook-task-sync", "mock-agent"} {
		cmd := exec.Command(goBin, "list", "-deps", "../../cmd/"+pkg)
		out, err := cmd.Output()
		require.NoError(t, err, pkg)
		for _, dep := range strings.Fields(string(out)) {
			assert.NotEqual(t, "testing", dep, "cmd/%s links the testing package: a production file imports it (internal/testguard.InTest is the check that does not)", pkg)
		}
	}
}

// #10014: a shipped binary whose launcher gives it a -test.* argument counts as a test for the package-init scrub (InTest, which has to answer before the flags exist) but is NOT a test run: its test flags
// are not registered, so what acts on a test-only environment variable (dbcrypt's migration fault injection) stays off. The probe is a plain main package run with such an argument.
func TestAShippedBinaryGivenTestFlagsIsNotATestRun(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("no go command to run the probe")
	}
	cmd := exec.Command(goBin, "run", "./testdata/probe", "-test.timeout=1m")
	out, err := cmd.CombinedOutput()
	require.NoError(t, err, string(out))
	assert.Equal(t, "InTest=true InTestRun=false\n", string(out))
}
