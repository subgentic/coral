package ptymanager

import (
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func displayWorkingFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "display_activity_hint", "codex-0.163.0", name))
	require.NoError(t, err)
	return string(b)
}
func TestCodexDisplayWorking7974RealAndComposedPrompts(t *testing.T) {
	working := displayWorkingFixture(t, "approved-working.txt")
	require.True(t, CodexDisplayWorkingOnScreen(working), "real approved working footer")
	require.True(t, CodexDisplayWorkingOnScreen(displayWorkingFixture(t, "never-working.txt")), "real background-terminal footer")
	dialog := displayWorkingFixture(t, "exec-dialog.txt")
	require.False(t, CodexDisplayWorkingOnScreen(dialog), "real exec dialog")
	// Explicitly COMPOSED: retain the real menu geometry, replace its question
	// wording, and put a working status above it (a live dialog must still win).
	for _, kind := range []string{"exec", "apply_patch", "network", "MCP elicitation", "request_user_input"} {
		t.Run("composed "+kind+" with working above dialog", func(t *testing.T) {
			composed := "• Working (3m 23s • esc to interrupt)\n› Ask Codex to do anything\nWould you like to approve " + kind + "?\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel\n"
			_, busy := codexWorkingMatching(composed, codexDisplayWorkingRe)
			require.True(t, busy, "the working signal alone is positive")
			open, _ := PromptOnScreen(composed)
			require.True(t, open, "the gate's detector sees the composed prompt")
			require.False(t, CodexDisplayWorkingOnScreen(composed))
		})
	}
	for _, screen := range []string{"", "⚠ 1 warning · f2 to view", "• Working (10s • esc to interrupt)", "quoted Working (10s • esc to interrupt)\n› Ask Codex to do anything"} {
		require.False(t, CodexDisplayWorkingOnScreen(screen), "no trustworthy current working/input geometry")
	}
	// A replay tail that lost its input box cannot prove there is no dialog.
	require.False(t, CodexDisplayWorkingOnScreen(strings.ReplaceAll(working, "› Ask Codex to do anything", "output without a box")))
}
