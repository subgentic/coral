package sessionstate

import (
	"os"
	"testing"

	"github.com/subgentic/coral/internal/testtemp"
)

// TestMain runs the package's tests in a private temp, home and data folder (#356): see internal/testtemp.
func TestMain(m *testing.M) {
	os.Exit(testtemp.Run(m))
}
