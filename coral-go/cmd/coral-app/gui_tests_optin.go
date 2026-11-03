//go:build webview && darwin

package main

// guiTestsEnv names the opt-in for the tests that open real windows (#12836).
const guiTestsEnv = "CORAL_ALLOW_GUI_TESTS"

// guiTestsSkipMessage is what a run without the opt-in says before it ends without running them.
const guiTestsSkipMessage = "skipped: these tests open real macOS windows. NEVER run them from an agent's shell under Coral: macOS then counts the test program as part of Coral.app and, when it exits, " +
	"force-quits Coral's tmux server and every agent (2026-11-03). From your own terminal, outside Coral, set " + guiTestsEnv + "=1 to run them."

// guiTestsAllowed says the opt-in is set: exactly "1".
func guiTestsAllowed(getenv func(string) string) bool { return getenv(guiTestsEnv) == "1" }
