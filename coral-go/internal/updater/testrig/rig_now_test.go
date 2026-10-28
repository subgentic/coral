package testrig

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rigNow is the check's clock for a test that publishes a signed release: a moment a little after now, never a fixed date. The rig's certificates are issued at the real clock (valid from then for ten
// minutes), so a clock fixed at a date passes only on the day it was written for and fails once the real time is past it (#10244: "2026-10-28 12:00Z" failed every run from 12:00Z that day). A
// manifest and a certificate from just before this moment are valid at it, and the test has minutes to finish.
func rigNow() time.Time { return time.Now().UTC().Add(2 * time.Minute).Truncate(time.Second) }

// A fixed date in a rig test is the next time bomb (#10244): none of these tests may build its clock from a time.Date of a year; rigNow is the clock.
func TestNoRigTestFixesItsClockToADate(t *testing.T) {
	files, err := filepath.Glob("*_test.go")
	require.NoError(t, err)
	for _, f := range files {
		body, err := os.ReadFile(f)
		require.NoError(t, err)
		assert.NotContains(t, string(body), "time.Date("+"20", f+": a clock fixed at a date passes only on its own day: use rigNow()")
	}
}
