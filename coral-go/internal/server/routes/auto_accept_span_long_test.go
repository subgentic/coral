package routes

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #7222 (Security's #7208 review): the Agy command ends at the LAST approval-question line (two such lines ask), and the Codex run-command header is searched over the whole capture above the menu, not
// a window of 40 lines, with two headers asking.
func agyCapture(body string) string {
	return body + "\nRun this command?\n  1. Yes, and always allow in this conversation for commands that start with 'x'\n> 2. Yes, run command\n  3. No, cancel\n\n  \u2191/\u2193 Navigate \u00b7 tab Amend \u00b7 ctrl+g edit/expand command\n"
}

func TestAgyCommandThatPrintsTheQuestionAsks(t *testing.T) {
	risk := func(capture string) (bool, string) {
		d := classifyApproval(at.Agy, capture)
		return d.Approve, autoAcceptRisk(at.Agy, t.TempDir(), nil, d, capture)
	}
	for name, body := range map[string]string{
		"echo, a question line, then rm":            "Requesting permission for:\n   echo ok\nRun this command?\n   rm -rf /etc/x\n",
		"the rm first, then a question line":        "Requesting permission for:\n   rm -rf /etc/x\nRun this command?\n   echo done\n",
		"allow this action":                         "Requesting permission for:\n   echo ok\nAllow this action?\n   rm -rf /etc/x\n",
		"do you want to run":                        "Requesting permission for:\n   echo ok\nDo you want to run it?\n   rm -rf /etc/x\n",
		"two question lines around harmless lines":  "Requesting permission for:\n   echo ok\nRun this command?\n   echo again\n",
		"a question line as the first command line": "Requesting permission for:\nRun this command?\n   rm -rf /etc/x\n",
	} {
		_, why := risk(agyCapture(body))
		assert.NotEmpty(t, why, "must ask: %s", name)
	}
	// a header and no real question line above the menu: a question line the command printed must not end the command and hide what follows (#7234)
	noQuestion := func(body string) string {
		return body + "\n  1. Yes, and always allow in this conversation for commands that start with 'x'\n> 2. Yes, run command\n  3. No, cancel\n"
	}
	for name, body := range map[string]string{
		"echo, a printed question line, rm, no real question": "Requesting permission for:\n   echo ok\nRun this command?\n   rm -rf /etc/x\n",
		"the printed question line last":                      "Requesting permission for:\n   echo ok\n   rm -rf /etc/x\nRun this command?\n   echo done\n",
		"no question at all, a harmless command":              "Requesting permission for:\n   go test ./...\n",
		"a rule line then no question":                        "Requesting permission for:\n   echo ok\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n",
	} {
		_, why := risk(noQuestion(body))
		assert.NotEmpty(t, why, "must ask: %s", name)
	}
	approve, why := risk(agyCapture("Requesting permission for:\n   go test ./...\n"))
	assert.Empty(t, why)
	assert.True(t, approve, "an ordinary command is still approved")
}

func TestCodexLongCommandCannotHideItsFirstLinesBeyondTheWindow(t *testing.T) {
	filler := func(n int) string {
		var b strings.Builder
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "    echo filler %d\n", i)
		}
		return b.String()
	}
	// a 45-line command whose first line is the rm and which prints a header near its end: two headers
	_, why := codexRisk(t, codexPrompt("  $ rm -rf /etc/x\n"+filler(43)+"  Would you like to run the following command?\n  $ ls\n"))
	assert.NotEmpty(t, why, "two headers ask, even 45 lines apart")
	// the same with the rm and the fake header more than 40 lines apart and the header the only thing at the end
	_, why = codexRisk(t, codexPrompt("  $ rm -rf /etc/x\n"+filler(60)+"  Would you like to run the following command?\n"))
	assert.NotEmpty(t, why)
	// a long harmless command is read whole from its header and approved
	approve, why := codexRisk(t, codexPrompt("  $ echo start\n"+filler(55)))
	assert.Empty(t, why, "a long harmless command passes")
	assert.True(t, approve, "and is approved now that its header is found")
	// a long command whose rm is on a late line asks
	_, why = codexRisk(t, codexPrompt("  $ echo start\n"+filler(55)+"    rm -rf /etc/x\n"))
	assert.NotEmpty(t, why)
	// Agy has the same whole-capture search
	agy := func(body string) (bool, string) {
		capture := agyCapture(body)
		d := classifyApproval(at.Agy, capture)
		return d.Approve, autoAcceptRisk(at.Agy, t.TempDir(), nil, d, capture)
	}
	_, why = agy("Requesting permission for:\n   rm -rf /etc/x\n" + strings.Repeat("   echo filler\n", 50) + "Requesting permission for:\n   ls\n")
	assert.NotEmpty(t, why, "two Agy headers ask, even 50 lines apart")
}
