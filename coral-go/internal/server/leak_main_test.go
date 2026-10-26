package server

import (
	"os"
	"testing"

	"github.com/subgentic/coral/internal/testleak"
)

// TestMain fails the package when its tests leave a goroutine running (#4167).
func TestMain(m *testing.M) {
	code := m.Run()
	os.Exit(testleak.Check(code))
}
