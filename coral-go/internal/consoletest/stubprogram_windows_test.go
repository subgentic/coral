//go:build windows

package consoletest

import (
	"os"
	"strings"
	"testing"
	"time"
)

// The stand-in program is its own: starting it with a CLI probe's arguments exits 0 at once and prints nothing, and it is not the test binary (which, started so, would run the
// whole suite again).
func TestTheStubProgramIsNeverTheTestBinaryAndExitsAtOnce(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stubExe := StubProgram(t)
	if strings.EqualFold(stubExe, self) {
		t.Fatalf("the stand-in CLI program is this test binary: %s", self)
	}
	// -test.run=^$ keeps even a wrong answer (this binary) from running anything.
	cmd := HiddenCommand(stubExe, "-test.run=^$", "auth", "status", "--json")
	done := make(chan struct{})
	var out []byte
	go func() { out, err = cmd.CombinedOutput(); close(done) }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		t.Fatal("the stand-in CLI program did not exit")
	}
	if err != nil || len(out) != 0 {
		t.Fatalf("the stand-in CLI program should exit 0 and print nothing: err=%v output=%q", err, out)
	}
}
