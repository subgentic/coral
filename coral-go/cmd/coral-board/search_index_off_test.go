package main

import (
	"os"
	"testing"
)

// The message search index is on by default (#9685): the tests' stores would each build one in the background. The tests of the index and of the setting set the variable themselves (Security Reviewer's LOW).
func TestMain(m *testing.M) {
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	os.Exit(m.Run())
}
