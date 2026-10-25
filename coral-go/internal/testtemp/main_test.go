package testtemp

import (
	"os"
	"testing"
)

// TestMain runs this package's tests in a private world like every other package's, which is what the canary below checks.
func TestMain(m *testing.M) { os.Exit(Run(m)) }
