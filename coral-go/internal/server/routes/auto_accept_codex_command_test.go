package routes

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #7208 (Security's #7206 points 2 and 3, QA's #7205 points a, b, c): what a Codex approval dialog shows is the only source of the command when no PreToolUse input is known (Codex hooks not approved).
// Every screen below is the codex_exec capture with its command block replaced by a command that runs a recursive delete outside the working folder, in a shape the reader used to lose; each must
// ask. The controls at the end must keep passing: a safe command, a Reason line before the command, a path wrapped mid-word.
func codexCommandScreen(t *testing.T, command string) string {
	t.Helper()
	exec := autoAcceptScreen(t, "codex_exec")
	block := "  $ touch\n  /private/tmp/claude-501/-Users-user-Software-coral-coral-go/524ee9ff-38dc-866f-4c51-0644d1c95849/scratchpad/pr\n  obe/outside2.txt\n"
	require.Contains(t, exec, block, "the fixture's command block")
	return strings.Replace(exec, block, command, 1)
}

func codexScreenRisk(t *testing.T, work, command string) (approved bool, risk string) {
	t.Helper()
	screen := codexCommandScreen(t, command)
	d := classifyApproval(at.Codex, screen)
	require.True(t, d.Prompt, "the dialog is recognised:\n%s", command)
	if !d.Approve {
		return false, ""
	}
	return true, autoAcceptRisk(at.Codex, work, nil, d, screen)
}

func TestCodexScreenCommandIsReadWhole(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix paths")
	}
	work := t.TempDir()
	outside := filepath.Join(filepath.Dir(work), "qa7208-outside") // never created: the text of a command, not run
	rule := "  " + strings.Repeat(string(rune(0x2500)), 20) + "\n"
	header := "  Would you like to run the following command?\n"
	cases := map[string]string{
		// Security #7206 point 2: lines joined with spaces read `echo ok rm -rf x` as one echo.
		"a second line is its own command": "  $ echo ok\n  rm -rf " + outside + "\n",
		"a second line after a safe first": "  $ true\n  rm -rf " + outside + "\n  true\n",
		// Security #7206 point 3 and QA (a): the nearest header above the menu is not the first.
		"a header line after the rm":   "  $ rm -rf " + outside + "\n" + header + "  true\n",
		"the rm after a second header": "  $ true\n" + header + "  rm -rf " + outside + "\n",
		"two headers around the rm":    header + "  $ true\n  rm -rf " + outside + "\n" + header + "  true\n",
		// QA (b): lines that start with the dialog's own labels are skipped from the command.
		"a Reason line that holds the rm":      "  $ echo hi\n  Reason: ; rm -rf " + outside + "\n",
		"a Description line that holds the rm": "  $ echo hi\n  Description: ; rm -rf " + outside + "\n",
		"an Environment line that holds rm":    "  $ echo hi\n  Environment: ; rm -rf " + outside + "\n",
		// QA (c): a rule line inside the span starts it after the rm.
		"a rule line after the rm":  "  $ rm -rf " + outside + "\n" + rule + "  true\n",
		"a rule line before the rm": "  $ true\n" + rule + "  rm -rf " + outside + "\n",
	}
	for name, command := range cases {
		t.Run(name, func(t *testing.T) {
			approved, risk := codexScreenRisk(t, work, command)
			if approved {
				assert.NotEmpty(t, risk, "an rm -rf outside the working folder must wait for the person:\n%s", command)
			}
		})
	}
}

func TestCodexScreenCommandControlsStillPass(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix paths")
	}
	work := t.TempDir()
	outside := filepath.Join(filepath.Dir(work), "qa7208-outside")
	// Reason, Environment and Description lines BEFORE the $ line are the dialog's own, not the command.
	approved, risk := codexScreenRisk(t, work, "  Reason: the old rm -rf "+outside+" failed; allow this echo?\n  Environment: local\n  Description: not an rm -rf "+outside+"\n\n  $ echo hi\n")
	assert.True(t, approved)
	assert.Empty(t, risk, "words in the dialog's own Reason, Environment and Description lines are not the command")
	// A safe command, one line and several.
	for _, c := range []string{"  $ echo hi\n", "  $ echo hi\n  echo there\n", "  $ git status --short\n"} {
		approved, risk = codexScreenRisk(t, work, c)
		assert.True(t, approved, c)
		assert.Empty(t, risk, c)
	}
	// A path inside the working folder, wrapped mid-word by the terminal, is still the one path.
	approved, risk = codexScreenRisk(t, work, "  $ touch\n  "+work+"/sub/ab\n  cd.txt\n")
	assert.True(t, approved)
	assert.Empty(t, risk, "a wrapped in-folder path is not a risk")
	// An rm outside, plainly, still asks (the baseline the cases above must match).
	approved, risk = codexScreenRisk(t, work, "  $ rm -rf "+outside+"\n")
	assert.True(t, approved)
	assert.NotEmpty(t, risk)
}
