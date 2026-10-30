package ptymanager

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// #408, Windows: a .bat or .cmd that IS the resolved CLI and stays alive with nothing started below it (it blocks in a builtin, as a stand-in does) is the agent itself. The recognised launcher
// cmd (its /c target is exactly the resolved CLI) with no child is a program, not a shell with nothing under it. One that starts a program keeps the older rule: that program is the CLI's own.

const wrapperCLI = `C:\Tools\oldstub.cmd`

func TestALauncherCmdThatIsTheCLIAndStartsNothingIsTheAgent(t *testing.T) {
	line := cmdExe + ` /d /c ""` + wrapperCLI + `""`
	f := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").withLine(200, line)

	progs, unknown, deep := programsBelow(f, root)
	assert.Empty(t, progs, "without the resolved CLI no cmd counts as the agent's launcher (the bug)")
	assert.Empty(t, unknown)
	assert.False(t, deep)

	progs, _, _ = programsBelowCLI(f, root, wrapperCLI)
	if assert.Len(t, progs, 1, "the cmd is the one program") {
		assert.Equal(t, 200, progs[0].pid)
		assert.True(t, progs[0].launched, "it is the CLI's own process")
		assert.Empty(t, progs[0].via, "not under a nested shell: no acknowledgement is needed")
	}

	// A console host beside it is not a child that counts.
	g := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").withLine(200, line).add(200, 201, 21, kindConsoleHost)
	progs, _, _ = programsBelowCLI(g, root, wrapperCLI)
	assert.Len(t, progs, 1)
}

func TestALauncherCmdThatStartsAProgramKeepsTheOlderRule(t *testing.T) {
	line := cmdExe + ` /d /c "` + wrapperCLI + `"`
	f := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").withLine(200, line).addNamed(200, 300, 30, kindProgram, "node")
	progs, _, _ := programsBelowCLI(f, root, wrapperCLI)
	if assert.Len(t, progs, 1) {
		assert.Equal(t, 300, progs[0].pid, "the program behind the launcher, not the cmd")
		assert.True(t, progs[0].launched)
	}
}

func TestAnyOtherCmdWithNoChildStaysAShell(t *testing.T) {
	for name, line := range map[string]string{
		"an interactive cmd":                      cmdExe,
		"cmd /k the CLI":                          cmdExe + ` /k "` + wrapperCLI + `"`,
		"cmd running another batch file":          cmdExe + ` /c "C:\Tools\other.cmd"`,
		"the CLI chained with another command":    cmdExe + ` /c "` + wrapperCLI + `" & bash`,
		"a cmd whose command line cannot be read": "",
	} {
		f := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd")
		if line != "" {
			f.withLine(200, line)
		}
		progs, _, _ := programsBelowCLI(f, root, wrapperCLI)
		assert.Empty(t, progs, name)
	}

	// The launcher cmd beside another program is not the launcher (a sibling means a person is running something else there).
	line := cmdExe + ` /d /c "` + wrapperCLI + `"`
	f := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").withLine(200, line).add(root, 201, 21, kindProgram)
	progs, _, _ := programsBelowCLI(f, root, wrapperCLI)
	if assert.Len(t, progs, 1) {
		assert.Equal(t, 201, progs[0].pid, "only the sibling program")
	}

	// A nested cmd, not a direct child of the terminal's root, is never the launcher.
	h := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 210, 21, kindVerifiedShell, "cmd").withLine(210, line)
	progs, _, _ = programsBelowCLI(h, root, wrapperCLI)
	assert.Empty(t, progs)
}
