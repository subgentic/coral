package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMissingCommandInReadsEachShellsError(t *testing.T) {
	for name, out := range map[string]string{
		"powershell":       "PS D:/w> & codex --x\ncodex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling\nAt line:1 char:1",
		"powershell plain": "The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program.",
		// PowerShell 7 words it "a name of ... executable program" (its source: DiscoveryExceptions.resx, key CommandNotFoundException, in https://github.com/PowerShell/PowerShell).
		"powershell 7":                        "The term 'codex' is not recognized as a name of a cmdlet, function, script file, or executable program." + "\n" + "Check the spelling of the name, or if a path was included, verify that the path is correct and try again.",
		"powershell wrapped in a narrow pane": "codex : The term 'codex' is not recognized as the name of a" + "\n" + "cmdlet, function, script file, or operable" + "\n" + "program. Check the spelling",
		"powershell 7 wrapped mid-phrase":     "The term 'codex' is not recognized as a name" + "\n" + "of a cmdlet, function, script file, or executable" + "\n" + "program.",
		"cmd wrapped":                         "'codex' is not recognized as an internal or" + "\n" + "external command, operable program or batch file.",
		"powershell exe":                      "The term 'codex.exe' is not recognized as the name of a cmdlet, function, script file, or operable program.",
		"cmd":                                 "C:/w>codex\n'codex' is not recognized as an internal or external command,\noperable program or batch file.",
		"bash":                                "bash: codex: command not found",
		"bash line":                           "bash: line 1: codex: command not found\n",
		"dash":                                "sh: 1: codex: not found",
		"zsh":                                 "zsh: command not found: codex",
		"bare":                                "codex: command not found",
	} {
		assert.True(t, MissingCommandIn(out, "codex"), name)
	}
}

func TestMissingCommandInIgnoresOtherCommandsAndTheAgentsOwnWords(t *testing.T) {
	for name, out := range map[string]string{
		"another command": "The term 'git' is not recognized as the name of a cmdlet, function, script file, or operable program.",
		"a longer name":   "bash: codexx: command not found",
		"a prefix name":   "bash: mycodex: command not found",
		"nothing":         "",
		"the agent talks": "I ran it and got: the CLI said codex was fine and nothing was not found there",
		"a path":          "ls: cannot access '/usr/bin/codex': No such file or directory",
	} {
		assert.False(t, MissingCommandIn(out, "codex"), name)
	}
	assert.False(t, MissingCommandIn("bash: codex: command not found", ""), "no binary named")
}

// The coral-go-team Security's INFO on #173: only the shell's answer to Coral's own launch line counts. The line is found by the session id it
// sets; text above it, or far below it, is not the launch's; with no such line on the screen there is nothing to read.
func TestAfterLaunchLineIsTheShellsAnswerToCoralsLine(t *testing.T) {
	const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	launch := "PS D:\\w> $env:CORAL_SESSION_ID = '" + sid + "'; & codex --x"
	err := "codex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."

	got, ok := AfterLaunchLine(launch+"\n"+err+"\nPS D:\\w> ", sid)
	if !ok || !MissingCommandIn(got, "codex") {
		t.Fatalf("the error right under the launch line is its answer: %q %v", got, ok)
	}
	if got, ok := AfterLaunchLine(err+"\n"+launch+"\n", sid); !ok || MissingCommandIn(got, "codex") {
		t.Errorf("an error above the launch line is not its answer: %q", got)
	}
	far := launch + "\n" + strings.Repeat("agent output\n", launchAnswerLines) + err
	if got, ok := AfterLaunchLine(far, sid); !ok || MissingCommandIn(got, "codex") {
		t.Errorf("the words far below the launch line are an agent's output, not the shell's answer: %q", got)
	}
	again := launch + "\n" + err + "\nPS D:\\w> $env:CORAL_SESSION_ID = '" + sid + "'; & codex --x\nWelcome to Codex"
	if got, ok := AfterLaunchLine(again, sid); !ok || MissingCommandIn(got, "codex") {
		t.Errorf("the LAST launch line counts (a wake that started): %q", got)
	}
	if _, ok := AfterLaunchLine(err+"\nPS D:\\w> ", sid); ok {
		t.Error("no launch line on the screen: nothing can be tied to the launch")
	}
	echoed := launch + "\n" + err + "\nPS D:\\w> echo " + sid + "\n" + sid + "\nbash: codex: command not found"
	if got, ok := AfterLaunchLine(echoed, sid); !ok || !strings.HasPrefix(got, err) {
		t.Errorf("a line that only shows the id (an echo) is not the launch: the answer is still the launch line's: %q", got)
	}
	unix := "w$ unset TMUX; export CORAL_SESSION_ID='" + sid + "' CORAL_PORT='8450'; codex --x\nbash: codex: command not found"
	if got, ok := AfterLaunchLine(unix, sid); !ok || !MissingCommandIn(got, "codex") {
		t.Errorf("the Unix launch line sets it with export: %q %v", got, ok)
	}
	if _, ok := AfterLaunchLine("w$ echo "+sid+"\nbash: codex: command not found", sid); ok {
		t.Error("only an echo of the id on the screen: no launch line")
	}
	if got, ok := AfterLaunchLine(launch, sid); !ok || got != "" {
		t.Errorf("a launch line with nothing under it yet: %q %v", got, ok)
	}
	if _, ok := AfterLaunchLine(launch+"\n"+err, ""); ok {
		t.Error("no session id: no launch line")
	}
}
