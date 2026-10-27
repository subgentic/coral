package board

import (
	"os"
	"testing"

	"github.com/subgentic/coral/internal/testleak"
)

// TestMain fails the package when its tests leave a goroutine running (#4167).
func TestMain(m *testing.M) {
	// The message search index is on by default (#9685): the tests' stores would each build one in the background. The tests of the index and of the setting set the variable themselves.
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	os.Exit(testleak.Check(m.Run()))
}
