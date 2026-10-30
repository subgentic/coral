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

// The coral-go-team Security's INFO on #173, after QA's tmux run: Coral's quiet launch clears the screen, so only the bottom tells what the shell
// last answered. The error marks only when it is the shell's latest answer, right above the prompt it came back to.
func TestMissingCommandAtBottomIsTheShellsLatestAnswer(t *testing.T) {
	const ps51 = "codex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the\n" +
		"spelling of the name, or if a path was included, verify that the path is correct and try again.\n" +
		"At line:1 char:1\n+ codex --x\n+ ~~~~~\n    + CategoryInfo          : ObjectNotFound: (codex:String) [], CommandNotFoundException\n" +
		"    + FullyQualifiedErrorId : CommandNotFoundException\n"
	const ps7 = "codex: The term 'codex' is not recognized as a name of a cmdlet, function, script file, or executable program.\n" +
		"Check the spelling of the name, or if a path was included, verify that the path is correct and try again.\n"
	const cmd = "'codex' is not recognized as an internal or external command,\noperable program or batch file.\n"
	launch := "PS D:\\w> $env:CORAL_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; & codex --x"
	for name, tc := range map[string]struct {
		screen string
		want   bool
	}{
		"QA's tmux screen: the answer and the prompt only": {"bash: codex: command not found\nuser@box:~/w$ ", true},
		"zsh": {"zsh: command not found: codex\n% ", true},
		"sh":  {"sh: 1: codex: not found\n$ \n\n", true},
		"Windows PowerShell 5.1, then its prompt":                 {ps51 + "\nPS D:\\w> ", true},
		"PowerShell 7, then its prompt":                           {ps7 + "PS D:\\w> ", true},
		"cmd, wrapped, then its prompt":                           {cmd + "\nD:\\w>", true},
		"a 23-column tmux pane breaks bash's error mid-word":      {"bash: claude: command n\not found\nuser@box:~/w$ ", true},
		"PowerShell's sentence broken mid-word":                   {"codex : The term 'codex' is not recogni\nzed as the name of a cmdlet, function, scrip\nt file, or operable program.\nPS> ", true},
		"a narrow pane wraps the sentence":                        {"codex : The term 'codex' is\nnot recognized as the name\nof a cmdlet, function,\nscript file, or operable\nprogram.\nPS> ", true},
		"the words, then other output, then a prompt":             {"bash: codex: command not found\nsome output\n$ ", false},
		"the words, then a typed command, then a prompt":          {"bash: codex: command not found\n$ ls\n$ ", false},
		"PowerShell's error, then a typed command, then a prompt": {ps51 + "\nPS D:\\w> dir\nPS D:\\w> ", false},
		"the words above Coral's launch line, then a prompt":      {"bash: codex: command not found\n" + launch + "\n$ ", false},
		"another command's error":                                 {"bash: git: command not found\n$ ", false},
		"the error with no prompt under it yet":                   {"bash: codex: command not found", false},
		"an empty screen":                                         {"", false},
	} {
		if got := MissingCommandAtBottom(tc.screen, map[bool]string{true: "claude", false: "codex"}[strings.Contains(tc.screen, "claude")]); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

// QA's screens from the #253 live runs (WSL tmux and Windows ConPTY), as the capture route rendered them, with the run folder, user and host
// replaced by names of the same length (a wrapped row is as wide as the pane). A: the CLI missing, at 120 columns, the sentence broken mid-word
// ("cor" / "rect") and a blank row before the prompt, then 41 empty rows. C: the same at 30 columns, the record and the prompt wrapped. tmux C:
// bash's answer at 23 columns, "command n" / "ot found", and a prompt over three rows. All three mark. B: the same error, then the CLI's own
// output: the screen alone says it is the latest answer, so it is the reconciler's foreground check (the CLI is running) that leaves it alone.
func TestMissingCommandAtBottomOnQAsLiveScreens(t *testing.T) {
	conptyA := "claude : The term 'claude' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is cor\nrect and try again.\nAt line:1 char:1\n+ claude\n+ ~~~~~~\n    + CategoryInfo          : ObjectNotFound: (claude:String) [], CommandNotFoundException\n    + FullyQualifiedErrorId : CommandNotFoundException\n\nPS C:\\Users\\someone\\coral-run\\work>\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"
	conptyC := "claude : The term 'claude' is\nnot recognized as the name of\na cmdlet, function, script fil\ne, or operable program. Check\nthe spelling of the name, or i\nf a path was included, verify\nthat the path is correct and t\nry again.\nAt line:1 char:1\n+ claude\n+ ~~~~~~\n    + CategoryInfo          :\nObjectNotFound: (claude:String\n) [], CommandNotFoundException\n    + FullyQualifiedErrorId :\nCommandNotFoundException\n\nPS C:\\Users\\someone\\AppData\\Lo\n\\coral-run\\work>\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"
	tmuxC := "bash: claude: command n\not found\nsomeone@devbox:/home/so\nmeone/qa253-f58ec2984/w\nork$\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"
	for name, screen := range map[string]string{"ConPTY A, 120 columns": conptyA, "ConPTY C, 30 columns": conptyC, "tmux C, 23 columns": tmuxC} {
		if !MissingCommandAtBottom(screen, "claude") {
			t.Errorf("%s: the shell's latest answer is the CLI missing: not marked", name)
		}
	}
	conptyThenTyped := strings.Replace(conptyA, "PS C:\\Users\\someone\\coral-run\\work>", "PS C:\\Users\\someone\\coral-run\\work> dir\nPS C:\\Users\\someone\\coral-run\\work>", 1)
	if MissingCommandAtBottom(conptyThenTyped, "claude") {
		t.Error("the same screen with a typed command after the error: not the latest answer")
	}
}
