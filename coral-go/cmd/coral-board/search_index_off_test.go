package main

import (
	"os"
	"testing"

	"github.com/subgentic/coral/internal/testtemp"
)

// The message search index is on by default (#9685): the tests' stores would each build one in the background. The tests of the index and of the setting set the variable themselves (Security Reviewer's LOW).
func TestMain(m *testing.M) {
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	os.Exit(testtemp.Run(m)) // in a private temp, home and data folder (#356)
}
