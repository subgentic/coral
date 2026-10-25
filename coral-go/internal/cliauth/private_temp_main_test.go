package cliauth

import (
	"testing"

	"github.com/subgentic/coral/internal/secfile/secfiletest"
	"github.com/subgentic/coral/internal/testtemp"
)

// TestMain makes the package's secret files in a private temp folder, so a foreign entry on the
// real %TEMP% (Codex's sandbox adds one) can't fail its private-file checks (#28).
func TestMain(m *testing.M) {
	cleanupTemp := testtemp.Use() // a private temp, home and data folder for this package (#356)
	done := secfiletest.UsePrivateTemp()
	DisableProofForTests() // the package's stand-in servers answer the hello, not the proof; the proof has its own tests (proof_transport_test.go)
	code := m.Run()
	done()
	testtemp.Exit(cleanupTemp, code)
}
