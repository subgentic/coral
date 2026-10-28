package testguard

import (
	"os"
	"testing"
)

// The message search index is on by default (#9685): a store a test here opened would build one in the background. The package's tests open none, and this keeps it so when one does (Security Reviewer's LOW on #9706).
func TestMain(m *testing.M) {
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	os.Exit(m.Run())
}
