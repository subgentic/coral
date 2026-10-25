package tracking

import (
	"os"
	"testing"

	"github.com/subgentic/coral/internal/testtemp"
)

// TestMain clears CORAL_TELEMETRY_DISABLED, which CI sets for every job (windows-tests.yml, the
// release): these tests check what is sent, so with it set nothing was (#3920 T4). The tests that
// check the variable set it themselves.
func TestMain(m *testing.M) {
	cleanupTemp := testtemp.Use() // a private temp, home and data folder for this package (#356)
	os.Unsetenv("CORAL_TELEMETRY_DISABLED")
	testtemp.Exit(cleanupTemp, m.Run())
}
