package auth

import (
	"testing"

	"github.com/subgentic/coral/internal/secfile/secfiletest"
	"github.com/subgentic/coral/internal/testleak"
	"github.com/subgentic/coral/internal/testtemp"
)

// TestMain fails the package when its tests leave a goroutine running (#4167). Its secret files
// are made in a private temp folder, so a foreign entry on the real %TEMP% can't fail them (#28).
func TestMain(m *testing.M) {
	cleanupTemp := testtemp.Use() // a private temp, home and data folder for this package (#356)
	done := secfiletest.UsePrivateTemp()
	code := testleak.Check(m.Run())
	done()
	testtemp.Exit(cleanupTemp, code)
}
