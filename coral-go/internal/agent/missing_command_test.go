package agent

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMissingCommandInReadsEachShellsError(t *testing.T) {
	for name, out := range map[string]string{
		"powershell":       "PS D:/w> & codex --x\ncodex : The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling\nAt line:1 char:1",
		"powershell plain": "The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program.",
		"powershell exe":   "The term 'codex.exe' is not recognized as the name of a cmdlet, function, script file, or operable program.",
		"cmd":              "C:/w>codex\n'codex' is not recognized as an internal or external command,\noperable program or batch file.",
		"bash":             "bash: codex: command not found",
		"bash line":        "bash: line 1: codex: command not found\n",
		"dash":             "sh: 1: codex: not found",
		"zsh":              "zsh: command not found: codex",
		"bare":             "codex: command not found",
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
