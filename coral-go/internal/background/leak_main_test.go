package background

import (
	"os"
	"testing"
	"time"

	"go.uber.org/goleak"

	"github.com/subgentic/coral/internal/testleak"
)

// TestMain fails the package when its tests leave a goroutine running (#4167).
func TestMain(m *testing.M) {
	// The message search index is on by default (#9685): the tests' stores would each build one in the background. The tests of the index and of the setting set the variable themselves.
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	gitQueryTimeout = 2 * time.Minute // a loaded test machine must not turn a slow git start into a failed test (#10713)
	code := m.Run()
	// Tests that type through the real input gate leave a send held, so its process-wide retry loop is
	// asleep (2 s) when a short run ends: stop it before the check.
	os.Exit(testleak.Check(code,
		// killChildProcess's SIGKILL escalation: it sleeps 5 s after the SIGTERM and then kills what is
		// left of the step's process group, so it ends on its own; tests finish sooner than that.
		goleak.IgnoreAnyFunction("github.com/subgentic/coral/internal/background.killChildProcess.func1"),
	))
}
