package routes

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #7208 (Security's #7206 findings and QA's list): what a Codex approval prompt asks about is the whole span from the FIRST run-command header above the menu to option 1, read as the command it is. These
// are capture-shaped fixtures (there is no real capture in the repo).
func codexPrompt(body string) string {
	return "  Would you like to run the following command?\n\n" + body + "\n\u203a 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (a)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel\n"
}

func codexRisk(t *testing.T, capture string) (approve bool, why string) {
	t.Helper()
	d := classifyApproval(at.Codex, capture)
	return d.Approve, autoAcceptRisk(at.Codex, t.TempDir(), nil, d, capture)
}

func TestCodexPromptSpanIsJudgedWholeAndLineByLine(t *testing.T) {
	asks := map[string]string{
		// a command over several lines is judged line by line as well as joined
		"echo then rm, second line indented": "  $ echo ok\n    rm -rf /etc\n",
		"echo then rm, no marker":            "  $ echo ok\n  rm -rf /etc\n",
		"three lines":                        "  $ cd .\n    echo ok\n    rm -rf /etc\n",
		"git push force on a later line":     "  $ git status\n    git push --force origin main\n",
		// two headers: what the prompt asks about is unclear
		"a command that prints the header": "  $ rm -rf /etc && echo \"\n  Would you like to run the following command?\n  $ ls\"\n",
		"a header-looking first line":      "  $ echo \"\n  Would you like to run the following command?\n  \" ; rm -rf /etc\n",
		"two headers, nothing else risky":  "  $ echo ok\n  Would you like to run the following command?\n  $ ls\n",
		"two headers around harmless":      "  $ git status\n  Would you like to run the following command?\n  $ go build ./...\n  Would you like to make the following edits?\n",
		// lines that start like the prompt's own labels, after the command began, are the command's text
		"Reason-looking line":      "  $ echo ok\n    Reason: x; rm -rf /etc\n",
		"Description-looking line": "  $ echo ok\n    Description: y; rm -rf /etc\n",
		"Environment-looking line": "  $ echo ok\n    Environment: z; rm -rf /etc\n",
		// a box-drawing line inside the span does not open a new prompt
		"rule line after the rm": "  $ rm -rf /etc\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  echo done\n",
		"rule line before":       "  $ echo ok\n  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n  rm -rf /etc\n",
	}
	for name, body := range asks {
		_, why := codexRisk(t, codexPrompt(body))
		assert.NotEmpty(t, why, "must ask: %s", name)
	}
	passes := map[string]string{
		"one line":               "  $ go test ./...\n",
		"two harmless lines":     "  $ git status\n    go build ./...\n",
		"labels before the $":    "  Reason: run the tests\n  Environment: CI=1\n  $ go test ./...\n",
		"a long wrapped command": "  $ go test ./internal/server/routes ./internal/background ./internal/store\n    ./internal/startup ./pkg/tunnel\n",
		"a heredoc in the repo":  "  $ cat > notes.txt <<'EOF'\n    hello\n    EOF\n",
	}
	for name, body := range passes {
		approve, why := codexRisk(t, codexPrompt(body))
		assert.Empty(t, why, "must pass: %s", name)
		assert.True(t, approve, "still approved: %s", name)
	}
	// the span starts at the first header: a line above a command-printed header is still read
	d := classifyApproval(at.Codex, codexPrompt("  $ rm -rf /etc && echo \"\n  Would you like to run the following command?\n  $ ls\"\n"))
	assert.True(t, strings.Contains(strings.Join(d.Context, "\n"), "rm -rf /etc"), "the first header opens the span: %v", d.Context)
}

// The edit prompt ("make the following edits") shares the Codex span code: two headers ask, a plain one is judged by its path as before.
func TestCodexEditPromptSpanAsksOnTwoHeaders(t *testing.T) {
	edit := func(body string) string {
		return "  Would you like to make the following edits?\n\n" + body + "\n\u203a 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel\n"
	}
	_, why := codexRisk(t, edit("  Destination: /etc/hosts\n"))
	assert.NotEmpty(t, why, "an edit outside the folder asks")
	_, why = codexRisk(t, edit("  Destination: /etc/hosts\n  Would you like to make the following edits?\n  Destination: notes.txt\n"))
	assert.NotEmpty(t, why, "two headers ask")
	approve, why := codexRisk(t, edit("  Destination: notes.txt\n"))
	assert.Empty(t, why, "an in-folder edit passes")
	assert.True(t, approve)
}

// The Agy and Gemini reader opens its span at the first header above the menu as well, and asks on two.
func TestAgyPromptSpanIsReadFromTheFirstHeaderAndAsksOnTwo(t *testing.T) {
	agy := func(body string) string {
		return body + "\nRun this command?\n  1. Yes, and always allow in this conversation for commands that start with 'x'\n> 2. Yes, run command\n  3. No, cancel\n\n  \u2191/\u2193 Navigate \u00b7 tab Amend \u00b7 ctrl+g edit/expand command\n"
	}
	risk := func(capture string) (bool, string) {
		d := classifyApproval(at.Agy, capture)
		return d.Approve, autoAcceptRisk(at.Agy, t.TempDir(), nil, d, capture)
	}
	for name, body := range map[string]string{
		"two headers, nothing else risky": "Requesting permission for:\n   echo ok\nRequesting permission for:\n   ls\n",
		"rm then a header-looking line":   "Requesting permission for:\n   rm -rf /etc && echo \"\nRequesting permission for:\n   ls\"\n",
		"two lines, the second is an rm":  "Requesting permission for:\n   echo ok\n   rm -rf /etc\n",
		"a rule line before the rm":       "Requesting permission for:\n   echo ok\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n   rm -rf /etc\n",
		"rm above a rule line":            "Requesting permission for:\n   rm -rf /etc\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n   echo done\n",
	} {
		_, why := risk(agy(body))
		assert.NotEmpty(t, why, "must ask: %s", name)
	}
	approve, why := risk(agy("Requesting permission for:\n   go test ./...\n"))
	assert.Empty(t, why)
	assert.True(t, approve)
}
