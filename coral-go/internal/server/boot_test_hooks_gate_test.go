package server

import (
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/config"
)

// The page's testHooks flag (which ?tasks_tab=1 and the other suite-only switches read) is
// in the boot data only in a dev build started with CORAL_TEST_HOOKS=1: a prod build
// ignores the variable (#22109).
func TestBootTestHooksFlagIsDevOnly(t *testing.T) {
	t.Setenv("CORAL_TEST_HOOKS", "1")
	got := strings.Contains(string(bootJSON(false)), `"testHooks":true`)
	if got != config.TestHooksEnvHonoured {
		t.Fatalf("boot data testHooks = %v with CORAL_TEST_HOOKS=1, want %v (TestHooksEnvHonoured)", got, config.TestHooksEnvHonoured)
	}
	t.Setenv("CORAL_TEST_HOOKS", "")
	if strings.Contains(string(bootJSON(false)), "testHooks") {
		t.Fatal("boot data carries testHooks without CORAL_TEST_HOOKS=1")
	}
}
