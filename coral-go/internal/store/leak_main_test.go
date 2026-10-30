package store

import (
	"testing"

	"github.com/subgentic/coral/internal/testleak"
	"github.com/subgentic/coral/internal/testtemp"
)

// TestMain fails the package when its tests leave a goroutine running (#4167).
func TestMain(m *testing.M) {
	cleanupTemp := testtemp.Use() // a private temp, home and data folder for this package (#356)
	testtemp.Exit(cleanupTemp, testleak.Check(m.Run()))
}
