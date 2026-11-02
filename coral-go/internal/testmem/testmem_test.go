package testmem

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestHeldIsWhatTheRuntimeHolds(t *testing.T) {
	before := Held()
	buf := make([]byte, 64<<20)
	for i := range buf {
		buf[i] = 1 // touched: it counts
	}
	after := Held()
	if after < before+32<<20 {
		t.Fatalf("holding 64 MiB changed Held by %d bytes only", int64(after)-int64(before))
	}
	_ = buf[len(buf)-1]
}

func TestLimitMBReadsTheVariable(t *testing.T) {
	t.Setenv("CORAL_TEST_MAX_MB", "")
	if LimitMB(1500) != 1500 {
		t.Fatal("the default stands when the variable is empty")
	}
	t.Setenv("CORAL_TEST_MAX_MB", "300")
	if LimitMB(1500) != 300 {
		t.Fatal("the variable changes the limit")
	}
	t.Setenv("CORAL_TEST_MAX_MB", "x")
	if LimitMB(1500) != 1500 {
		t.Fatal("a value that is not a number is ignored")
	}
	t.Setenv("CORAL_TEST_MAX_MB", "0")
	if LimitMB(1500) != 0 {
		t.Fatal("0 turns the guard off")
	}
}

// A test binary over its limit is stopped with code 3 and the message, the moment it is over (the child process holds 200 MiB under a 50 MiB limit).
func TestAProcessOverItsLimitIsStopped(t *testing.T) {
	if os.Getenv("TESTMEM_CHILD") == "1" {
		stop := Start("child", 50)
		defer stop()
		hold := make([][]byte, 0, 8)
		for i := 0; i < 8; i++ {
			b := make([]byte, 25<<20)
			for j := range b {
				b[j] = 1
			}
			hold = append(hold, b)
			time.Sleep(200 * time.Millisecond)
		}
		_ = hold
		time.Sleep(2 * time.Second) // never reached when the guard works
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestAProcessOverItsLimitIsStopped$")
	cmd.Env = append(os.Environ(), "TESTMEM_CHILD=1")
	out, err := cmd.CombinedOutput()
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 3 {
		t.Fatalf("want exit code 3, got %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "over its 50 MiB limit") {
		t.Fatalf("the message is missing:\n%s", out)
	}
}

func TestAProcessUnderItsLimitPasses(t *testing.T) {
	stop := Start("here", 4000)
	time.Sleep(600 * time.Millisecond)
	if peak := stop(); peak <= 0 {
		t.Fatalf("a peak is reported: %d", peak)
	}
}
