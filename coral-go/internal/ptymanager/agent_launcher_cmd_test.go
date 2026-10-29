package ptymanager

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

const (
	shimCLI = `C:\Users\u\AppData\Roaming\npm\claude.cmd`
	cmdExe  = `C:\Windows\system32\cmd.exe`
)

// #391: the cmd that runs the resolved CLI is Coral's launcher, not a shell a person started. It is recognised by its command line only.
func TestIsLauncherCommandLine(t *testing.T) {
	for _, tc := range []struct {
		name  string
		line  string
		match bool
	}{
		{"the shim as PowerShell starts it", cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`, true},
		{"the same without the outer quotes", cmdExe + ` /d /s /c "` + shimCLI + `" --flag`, true},
		{"unquoted program path", cmdExe + ` /c ` + shimCLI + ` --flag`, true},
		{"flags in another order, with /q", cmdExe + ` /q /d /s /c "` + shimCLI + `"`, true},
		{"the path in another case", cmdExe + ` /c "` + strings.ToUpper(shimCLI) + `"`, true},
		{"cmd named without a folder", `cmd /c "` + shimCLI + `"`, true},
		{"condition: not interactive (cmd alone)", cmdExe, false},
		{"condition: not interactive (cmd /k)", cmdExe + ` /k "` + shimCLI + `"`, false},
		{"condition: runs something else (bash)", cmdExe + ` /c bash`, false},
		{"condition: runs something else (ping)", cmdExe + ` /c ping -n 20 127.0.0.1`, false},
		{"condition: exactly the resolved CLI (another claude.cmd)", cmdExe + ` /d /s /c ""C:\planted\claude.cmd" --flag"`, false},
		{"condition: no operator after it (&)", cmdExe + ` /c "` + shimCLI + `" & bash`, false},
		{"condition: no operator after it (&&)", cmdExe + ` /c "` + shimCLI + `" && bash`, false},
		{"condition: no operator after it (|)", cmdExe + ` /c "` + shimCLI + `" | more`, false},
		{"condition: no operator after it (>)", cmdExe + ` /c "` + shimCLI + `" > out.txt`, false},
		{"condition: no operator after it (^)", cmdExe + ` /c "` + shimCLI + `" ^& bash`, false},
		{"condition: no operator after it, with the outer quotes", cmdExe + ` /d /s /c ""` + shimCLI + `" --x & bash"`, false},
		{"an unquoted program glued to an operator", cmdExe + ` /c ` + shimCLI + `&bash`, false},
		{"an unknown flag", cmdExe + ` /x /c "` + shimCLI + `"`, false},
		{"/c is last, not first", cmdExe + ` /c /d "` + shimCLI + `"`, false},
		{"not cmd, with cmd's own switches", `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe /c "` + shimCLI + `"`, false},
		{"not cmd", `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -c "` + shimCLI + `"`, false},
		{"condition: a line longer than the buffer is not read", cmdExe + ` /c "` + shimCLI + `" ` + strings.Repeat("x", launcherCmdMaxLine), false},
		{"an empty line", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.match, isLauncherCommandLine(tc.line, shimCLI))
		})
	}
	assert.True(t, isLauncherCommandLine(cmdExe+` /c "`+shimCLI+`"`, `C:\Users\u\AppData\Roaming\npm\claude`), "the CLI resolved without its extension")
	assert.False(t, isLauncherCommandLine(cmdExe+` /c "`+shimCLI+`"`, ""), "no resolved CLI: nothing matches")
}

// The walk: node behind the shim is Under "" when the shim is a direct child of the root with no sibling program; every other cmd keeps it Under "cmd".
func TestProgramsBelowCountsTheLauncherCmdAsNoShell(t *testing.T) {
	good := cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`
	shim := func(line string) *fakeProcs {
		f := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node")
		if line != "" {
			f.withLine(200, line)
		}
		return f
	}
	viaOf := func(f *fakeProcs, cli string) string {
		c, why := candidateWinCLI(f, root, cli)
		assert.Empty(t, why)
		return c.via
	}

	assert.Equal(t, "", viaOf(shim(good), shimCLI), "the shim chain: node is the agent's, no nested shell")
	assert.Equal(t, "cmd", viaOf(shim(good), ""), "without the resolved CLI nothing matches")
	assert.Equal(t, "cmd", viaOf(shim(""), shimCLI), "an unreadable command line: nested (fail closed)")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe), shimCLI), "an interactive cmd")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe+` /k "`+shimCLI+`"`), shimCLI), "cmd /k")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe+` /c bash`), shimCLI), "cmd /c bash")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe+` /c ping -n 20 127.0.0.1`), shimCLI), "cmd /c ping")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe+` /d /s /c ""C:\planted\claude.cmd" --flag"`), shimCLI), "a shim that names another .cmd")
	assert.Equal(t, "cmd", viaOf(shim(cmdExe+` /c "`+shimCLI+`" & bash`), shimCLI), "an operator after the program")

	// condition: no sibling program beside the cmd.
	sibling := shim(good).addNamed(root, 400, 40, kindProgram, "claude")
	_, why := candidateWinCLI(sibling, root, shimCLI)
	assert.Contains(t, why, "several programs", "two programs: no candidate at all")
	progs, _, _ := programsBelowCLI(sibling, root, shimCLI)
	for _, p := range progs {
		if p.pid == 300 {
			assert.Equal(t, "cmd", p.via, "with a sibling program the cmd is not taken as the launcher")
		}
	}

	// condition: a direct child of the root. A cmd one shell down is not.
	deeper := pane().addNamed(root, 100+1, 15, kindVerifiedShell, "powershell").addNamed(101, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node").withLine(200, good)
	assert.Equal(t, "powershell", viaOf(deeper, shimCLI), "the first shell on the way is a PowerShell: nested")
}

// The candidate carries only the shell on the way: the command line is never kept in it.
func TestWinCandidateCarriesNoCommandLine(t *testing.T) {
	c := winCandidateFields(winProc{pid: 1, start: 2, via: "cmd"})
	assert.Equal(t, "cmd", c.Under)
}

const (
	handoffPS     = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	handoffScript = `C:\Users\u\AppData\Local\Coral\data\tmp\coral-command-1234567890.ps1`
)

func handoffLine(script string) string {
	return handoffPS + ` -NoProfile -ExecutionPolicy Bypass -File ` + script
}

// #391: Coral's handoff PowerShell is recognised by its command line: those flags, exactly the script Coral wrote for this launch, no other token.
func TestIsHandoffCommandLine(t *testing.T) {
	for _, tc := range []struct {
		name  string
		line  string
		match bool
	}{
		{"as Coral types it", handoffLine(handoffScript), true},
		{"the path in another case", handoffLine(strings.ToUpper(handoffScript)), true},
		{"the path with forward slashes", handoffLine(strings.ReplaceAll(handoffScript, `\`, "/")), true},
		{"the path quoted (it has a space)", handoffLine(`"` + handoffScript + `"`), true},
		{"flags in another case", handoffPS + ` -noprofile -executionpolicy bypass -file ` + handoffScript, true},
		{"pwsh, its folder quoted", `"C:\Program Files\PowerShell\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File ` + handoffScript, true},
		{"a different script in the same folder", handoffLine(`C:\Users\u\AppData\Local\Coral\data\tmp\coral-command-999.ps1`), false},
		{"a script in another folder with the same name", handoffLine(`C:\planted\coral-command-1234567890.ps1`), false},
		{"a parent-folder path to another file", handoffLine(`C:\Users\u\AppData\Local\Coral\data\tmp\..\coral-command-1234567890.ps1`), false},
		{"an extra token", handoffLine(handoffScript) + ` extra`, false},
		{"an extra flag", handoffPS + ` -NoProfile -NoExit -ExecutionPolicy Bypass -File ` + handoffScript, false},
		{"a different policy", handoffPS + ` -NoProfile -ExecutionPolicy Unrestricted -File ` + handoffScript, false},
		{"-Command instead of -File", handoffPS + ` -NoProfile -ExecutionPolicy Bypass -Command ` + handoffScript, false},
		{"no -NoProfile", handoffPS + ` -ExecutionPolicy Bypass -File ` + handoffScript, false},
		{"not a PowerShell", `C:\Windows\System32\cmd.exe -NoProfile -ExecutionPolicy Bypass -File ` + handoffScript, false},
		{"a typed powershell", handoffPS, false},
		{"an empty line", "", false},
		{"a line longer than the buffer is not read", handoffLine(handoffScript) + strings.Repeat(" x", launcherCmdMaxLine), false},
		{"a line longer than the buffer, padded with blanks only", handoffLine(handoffScript) + strings.Repeat(" ", launcherCmdMaxLine), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.match, isHandoffCommandLine(tc.line, handoffScript))
		})
	}
	assert.False(t, isHandoffCommandLine(handoffLine(handoffScript), ""), "no script recorded: nothing matches")
}

// The walk: powershell -File <Coral's script> -> launcher cmd -> node is a direct agent (Under ""); anything else keeps the PowerShell as the nested shell.
func TestProgramsBelowCountsCoralsHandoffPowerShellAsNoShell(t *testing.T) {
	launcher := cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`
	chain := func(psLine, cmdLine string) *fakeProcs {
		f := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "cmd").addNamed(300, 400, 40, kindProgram, "node")
		if psLine != "" {
			f.withLine(200, psLine)
		}
		if cmdLine != "" {
			f.withLine(300, cmdLine)
		}
		return f
	}
	viaOf := func(f *fakeProcs, cli, script string) string {
		c, why := candidateWinRule(f, root, cli, script)
		assert.Empty(t, why)
		return c.via
	}
	good := handoffLine(handoffScript)

	assert.Equal(t, "", viaOf(chain(good, launcher), shimCLI, handoffScript), "Coral's handoff chain: the agent is not under a nested shell")
	assert.Equal(t, "powershell", viaOf(chain(good, launcher), shimCLI, ""), "the script is unknown: fail closed")
	assert.Equal(t, "powershell", viaOf(chain(good, launcher), "", handoffScript), "no resolved CLI: nothing matches")
	assert.Equal(t, "powershell", viaOf(chain(handoffPS, launcher), shimCLI, handoffScript), "a typed powershell")
	assert.Equal(t, "powershell", viaOf(chain(handoffLine(`C:\other\coral-command-1.ps1`), launcher), shimCLI, handoffScript), "a different .ps1")
	assert.Equal(t, "powershell", viaOf(chain("", launcher), shimCLI, handoffScript), "an unreadable command line")
	assert.Equal(t, "powershell", viaOf(chain(good+" extra", launcher), shimCLI, handoffScript), "an extra token")
	assert.Equal(t, "powershell", viaOf(chain(good, ""), shimCLI, handoffScript), "the cmd below is unreadable")
	assert.Equal(t, "powershell", viaOf(chain(good, cmdExe), shimCLI, handoffScript), "the cmd below is interactive")
	assert.Equal(t, "powershell", viaOf(chain(good, cmdExe+` /c bash`), shimCLI, handoffScript), "the cmd below runs something else")

	// condition: the script's only child is the launcher cmd.
	two := chain(good, launcher).addNamed(200, 301, 31, kindProgram, "bash")
	progs, _, _ := programsBelowRule(two, root, shimCLI, handoffScript)
	for _, p := range progs {
		assert.Equal(t, "powershell", p.via, "a second child of the handoff PowerShell: it is a nested shell")
	}
	console := chain(good, launcher).add(200, 302, 32, kindConsoleHost)
	assert.Equal(t, "", viaOf(console, shimCLI, handoffScript), "a console host beside the cmd is not a program")

	// condition: the process is a PowerShell by its image, not by what its command line claims; and the cmd below is a cmd by its image.
	spoofCmd := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindVerifiedShell, "cmd").addNamed(300, 400, 40, kindProgram, "node").withLine(200, good).withLine(300, launcher)
	assert.Equal(t, "cmd", viaOf(spoofCmd, shimCLI, handoffScript), "a cmd whose command line claims to be Coral's PowerShell")
	spoofChild := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "powershell").addNamed(300, 400, 40, kindProgram, "node").withLine(200, good).withLine(300, launcher)
	assert.Equal(t, "powershell", viaOf(spoofChild, shimCLI, handoffScript), "the only child is a PowerShell whose command line claims to be the launcher cmd")

	// condition: no sibling program beside the PowerShell, and a direct child of the root.
	sibling := chain(good, launcher).addNamed(root, 500, 50, kindProgram, "claude")
	_, why := candidateWinRule(sibling, root, shimCLI, handoffScript)
	assert.Contains(t, why, "several programs")
	progs, _, _ = programsBelowRule(sibling, root, shimCLI, handoffScript)
	for _, p := range progs {
		if p.pid == 400 {
			assert.Equal(t, "powershell", p.via)
		}
	}
	deeper := pane().addNamed(root, 150, 15, kindVerifiedShell, "powershell").addNamed(150, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "cmd").
		addNamed(300, 400, 40, kindProgram, "node").withLine(200, good).withLine(300, launcher)
	assert.Equal(t, "powershell", viaOf(deeper, shimCLI, handoffScript), "a handoff PowerShell under the person's PowerShell")
	// the launcher cmd directly under the root keeps working without a handoff.
	assert.Equal(t, "", viaOf(pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node").withLine(200, launcher), shimCLI, ""))
}

// The session keeps the script of its launch: recording the agent of a handoff launch reports Under "", and a launch typed as it is (no script) does not.
func TestRecordWinUsesTheSessionsHandoffScript(t *testing.T) {
	launcher := cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`
	f := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "cmd").addNamed(300, 400, 40, kindProgram, "node").
		withLine(200, handoffLine(handoffScript)).withLine(300, launcher)
	var a winAgent
	got, err := a.recordWin(f, root, winProc{pid: 400, start: 40, acknowledged: true}, shimCLI)
	assert.NoError(t, err)
	assert.Equal(t, "powershell", got.via, "no script recorded: nested")

	a.noteLaunch(handoffScript, shimCLI)
	got, err = a.recordWin(f, root, winProc{pid: 400, start: 40, acknowledged: true}, shimCLI)
	assert.NoError(t, err)
	assert.Equal(t, "", got.via)

	a.noteLaunch("", "") // the next launch was typed as it is
	got, _ = a.recordWin(f, root, winProc{pid: 400, start: 40, acknowledged: true}, shimCLI)
	assert.Equal(t, "powershell", got.via)
}

// Item 6 of #391: the launcher cmd is compared with the CLI the session was launched with, so changing cli_path afterwards does not flip a running agent to "nested".
func TestTheLaunchCLIIsKeptWithTheSession(t *testing.T) {
	launcher := cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`
	f := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "cmd").addNamed(300, 400, 40, kindProgram, "node").
		withLine(200, handoffLine(handoffScript)).withLine(300, launcher)
	const changed = `C:\other\tools\claude.cmd` // cli_path as it is now
	var a winAgent
	a.noteLaunch(handoffScript, shimCLI)
	got, err := a.recordWin(f, root, winProc{pid: 400, start: 40, acknowledged: true}, changed)
	assert.NoError(t, err)
	assert.Equal(t, "", got.via, "the setting changed after the launch: the agent still reads Under ''")

	var unknown winAgent // no launch CLI was kept: today's setting is never used in its place, even when it matches the launcher cmd
	unknown.noteLaunch(handoffScript, "")
	got, err = unknown.recordWin(f, root, winProc{pid: 400, start: 40, acknowledged: true}, shimCLI)
	assert.NoError(t, err)
	assert.Equal(t, "powershell", got.via)

	// a different program under the launcher cmd is not the launcher's: the cmd is compared with the launch CLI, so another .cmd stays nested.
	other := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "evil").withLine(200, cmdExe+` /c "C:\planted\claude.cmd"`)
	c, why := candidateWinRule(other, root, shimCLI, "")
	assert.Empty(t, why)
	assert.Equal(t, "cmd", c.via)
	assert.False(t, c.launched)
}

// Launched: the program was reached through the recognised launcher cmd (a shim's node), so bulk may record it though its image is not the CLI file.
func TestLaunchedMarksTheProgramBehindTheRecognisedLauncher(t *testing.T) {
	launcher := cmdExe + ` /d /s /c ""` + shimCLI + `" --flag"`
	viaHandoff := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindVerifiedShell, "cmd").addNamed(300, 400, 40, kindProgram, "node").
		withLine(200, handoffLine(handoffScript)).withLine(300, launcher)
	c, why := candidateWinRule(viaHandoff, root, shimCLI, handoffScript)
	assert.Empty(t, why)
	assert.True(t, c.launched)
	assert.True(t, winCandidateFields(c).Launched)

	direct := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node").withLine(200, launcher)
	c, _ = candidateWinRule(direct, root, shimCLI, "")
	assert.True(t, c.launched, "the launcher cmd typed straight into the pane's shell")

	exe := pane().addNamed(root, 300, 30, kindProgram, "codex")
	c, _ = candidateWinRule(exe, root, shimCLI, "")
	assert.False(t, c.launched, "a CLI that is an .exe has no launcher: bulk compares its image")

	typed := pane().addNamed(root, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node").withLine(200, cmdExe)
	c, _ = candidateWinRule(typed, root, shimCLI, "")
	assert.False(t, c.launched, "an interactive cmd")
	assert.Equal(t, "cmd", c.via)

	nested := pane().addNamed(root, 150, 15, kindVerifiedShell, "powershell").addNamed(150, 200, 20, kindVerifiedShell, "cmd").addNamed(200, 300, 30, kindProgram, "node").withLine(200, launcher)
	c, _ = candidateWinRule(nested, root, shimCLI, "")
	assert.False(t, c.launched, "a launcher-looking cmd under a person's PowerShell")
}

// The acknowledgement is part of the record itself, as on Unix: a program under a nested shell is refused in the read that checks pid and start unless acknowledged.
func TestRecordWinRefusesANestedProgramWithoutTheAcknowledgement(t *testing.T) {
	nested := pane().addNamed(root, 200, 20, kindVerifiedShell, "powershell").addNamed(200, 300, 30, kindProgram, "node")
	var a winAgent
	_, err := a.recordWin(nested, root, winProc{pid: 300, start: 30}, "")
	assert.ErrorIs(t, err, ErrNeedsAcknowledgement)
	var need *NeedsAcknowledgementError
	if assert.ErrorAs(t, err, &need) {
		assert.Equal(t, "powershell", need.Under)
	}
	_, adopted, _ := a.snapshot()
	assert.False(t, adopted, "nothing was recorded")
	_, err = a.recordWin(nested, root, winProc{pid: 300, start: 30, acknowledged: true}, "")
	assert.NoError(t, err)

	direct := pane().addNamed(root, 300, 30, kindProgram, "codex")
	var b winAgent
	_, err = b.recordWin(direct, root, winProc{pid: 300, start: 30}, "")
	assert.NoError(t, err, "a direct child needs no tick")
}

// A program whose image cannot be read (no name) cannot be told from anything: its record needs the acknowledgement, and its candidate says so (Security on #391).
func TestRecordWinRefusesAnUnidentifiedProgramWithoutTheAcknowledgement(t *testing.T) {
	f := pane().add(root, 300, 30, kindProgram) // no image name
	var a winAgent
	_, err := a.recordWin(f, root, winProc{pid: 300, start: 30}, "")
	assert.ErrorIs(t, err, ErrNeedsAcknowledgement)
	var need *NeedsAcknowledgementError
	if assert.ErrorAs(t, err, &need) {
		assert.True(t, need.Unidentified)
		assert.Empty(t, need.Under)
	}
	_, adopted, _ := a.snapshot()
	assert.False(t, adopted, "nothing was recorded")
	_, err = a.recordWin(f, root, winProc{pid: 300, start: 30, acknowledged: true}, "")
	assert.NoError(t, err)

	program, folder, unidentified := describeImage(300, "")
	assert.Equal(t, "an unknown program (pid 300)", program)
	assert.Empty(t, folder)
	assert.True(t, unidentified)
	program, folder, _ = describeImage(300, `C:\Program Files\nodejs\node.exe`)
	assert.Equal(t, "node.exe", program)
	assert.Equal(t, "C:/Program Files/nodejs", folder)
}
