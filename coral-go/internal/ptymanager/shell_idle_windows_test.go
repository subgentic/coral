//go:build windows

package ptymanager

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/terminalinput"
)

// #378: on Windows the agent-exited guard (#3219) could never tell, as ConPTY names no shell pid for the ps check, so board notices
// were typed into the bare PowerShell an exited CLI left. A ConPTY session now says for itself: a shell with a program running in
// it is busy, the same shell back at its prompt is idle.
func TestWindowsShellIdleTellsABarePromptFromARunningProgram(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-378-idle"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0378", "powershell.exe -NoProfile", 120, 40))

	require.Eventually(t, func() bool {
		idle, shell, ok := b.ShellIdle(name)
		return ok && idle && shell == "powershell"
	}, 20*time.Second, 200*time.Millisecond, "a shell with nothing running in it is idle")

	// A program in the shell, as an agent CLI is: busy, so notices are typed to it.
	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("ping -n 6 127.0.0.1"+EnterKey)))
	require.Eventually(t, func() bool {
		idle, _, ok := b.ShellIdle(name)
		return ok && !idle
	}, 20*time.Second, 200*time.Millisecond, "a shell running a program is not idle")

	// The program ends (as an agent CLI exits): back at a bare prompt, idle again.
	require.Eventually(t, func() bool {
		idle, _, ok := b.ShellIdle(name)
		return ok && idle
	}, 20*time.Second, 200*time.Millisecond, "the shell is idle again once the program has exited")
}

// A program started directly as the terminal's root (an agent with no shell around it) is the agent itself: never idle.
func TestWindowsShellIdleADirectProgramIsNotIdle(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-378-direct"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0379", "ping.exe -n 30 127.0.0.1", 120, 40))
	time.Sleep(time.Second)
	idle, shell, ok := b.ShellIdle(name)
	if ok {
		assert.False(t, idle, "a direct program is not a bare shell (root %q)", shell)
	}
}

// #378, seen live: a person typed "cmd" at the bare PowerShell an exited agent left, and a task notice typed into that cmd ran the
// command after its '&'. Nested shells with nothing else running are still a bare prompt; a program in the nested shell is busy.
func TestWindowsShellIdleANestedShellIsStillABarePrompt(t *testing.T) {
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-378-nested"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0380", "powershell.exe -NoProfile", 120, 40))
	require.Eventually(t, func() bool { idle, _, ok := b.ShellIdle(name); return ok && idle }, 20*time.Second, 200*time.Millisecond, "a bare PowerShell")

	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("cmd"+EnterKey)))
	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("powershell -NoProfile"+EnterKey)))
	time.Sleep(3 * time.Second) // the two shells start
	for i := 0; i < 5; i++ {
		idle, _, ok := b.ShellIdle(name)
		require.True(t, ok)
		assert.True(t, idle, "PowerShell in cmd in PowerShell, nothing else: a bare prompt")
		time.Sleep(200 * time.Millisecond)
	}

	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("ping -n 6 127.0.0.1"+EnterKey)))
	require.Eventually(t, func() bool { idle, _, ok := b.ShellIdle(name); return ok && !idle }, 20*time.Second, 200*time.Millisecond, "a program in the nested shell is busy")
	require.Eventually(t, func() bool { idle, _, ok := b.ShellIdle(name); return ok && idle }, 20*time.Second, 200*time.Millisecond, "and a bare prompt again once it ends")
}

// #205 review: a console host under the shell is not a program the person runs, and the nested shells the Unix check knows (git-bash's
// bash, sh, zsh) are a bare prompt as cmd and PowerShell are. A program in git-bash cannot be seen from Windows, so it is one too.
func TestWindowsShellIdleCountsGitBashAsAShellAndIgnoresConsoleHosts(t *testing.T) {
	win, err := windows.GetSystemWindowsDirectory()
	require.NoError(t, err)
	for _, image := range []string{filepath.Join(win, "System32", "conhost.exe"), strings.ToUpper(filepath.Join(win, "System32", "conhost.exe")),
		`C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.22.11141.0_x64__8wekyb3d8bbwe\OpenConsole.exe`} {
		assert.True(t, consoleHostImage(image), image)
	}
	// a program that only takes a console host's name is still a program
	for _, image := range []string{`C:\Users\x\conhost.exe`, `conhost.exe`, `D:\tools\OpenConsole.exe`, filepath.Join(win, "System32", "cmd.exe"), `C:\x\node.exe`} {
		assert.False(t, consoleHostImage(image), image)
	}

	bash, err := exec.LookPath("bash.exe")
	if err != nil || !strings.Contains(strings.ToLower(bash), `\git\`) {
		t.Skip("no git-bash on PATH")
	}
	naming.SetDefaultLogDir(t.TempDir())
	b := NewPTYBackend()
	t.Cleanup(func() { _ = b.Close() })
	name := "claude-205-gitbash"
	require.NoError(t, b.Spawn(name, "claude", t.TempDir(), "0381", "powershell.exe -NoProfile", 120, 40))
	require.Eventually(t, func() bool { idle, _, ok := b.ShellIdle(name); return ok && idle }, 20*time.Second, 200*time.Millisecond, "a bare PowerShell")
	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("& '"+bash+"' --norc"+EnterKey)))
	time.Sleep(3 * time.Second) // bash starts
	idle, _, ok := b.ShellIdle(name)
	require.True(t, ok)
	assert.True(t, idle, "git-bash at the prompt, nothing else running: a bare prompt")
	// A program that is surely running when the test asserts busy (Security on #205): sleep starts, and only then the marker file is made;
	// "wait" keeps the program in the foreground, and its exit removes nothing the test needs. The trailing comment takes the Enter key's CR:
	// git-bash started from PowerShell may read its input as a stream, not a terminal, and would otherwise pass 8 and a CR to sleep, which
	// exits at once.
	marker := filepath.ToSlash(filepath.Join(t.TempDir(), "sleeping"))
	require.NoError(t, b.SendInput(terminalinput.Unclassified, name, []byte("sleep 8 & echo started > '"+marker+"'; wait #"+EnterKey)))
	require.Eventually(t, func() bool { _, err := os.Stat(marker); return err == nil }, 15*time.Second, 100*time.Millisecond, "sleep started in git-bash")
	// Measured (#205 follow-up, Windows 11, Git for Windows): while sleep runs, the session's tree is the root PowerShell and bash.exe
	// only. Git-bash's own children (the MSYS runtime's fork and exec) do not appear under it in Windows' process list, so a program
	// in git-bash is invisible here and the pane reads as a bare prompt. That is the answer the guard needs: Coral never starts an agent
	// CLI through git-bash, so what runs in it is the person's, and a notice is not typed into it. The cost is the safe one: an agent
	// CLI a person starts by hand inside git-bash would not get notices.
	idle, _, ok = b.ShellIdle(name)
	require.True(t, ok)
	t.Logf("git-bash's process tree while sleep runs: %s", processTreeOf(b, name))
	assert.True(t, idle, "a program in git-bash cannot be seen from Windows: the pane reads as a bare prompt, and nothing is typed into it")
	// #216: it is a shell of unknown contents, so no launch line is typed into it either (AgentExitedForLaunch)
	sh, ok := b.OtherShell(name)
	require.True(t, ok)
	assert.Equal(t, "bash", sh, "the walk sees bash.exe under the root and names it")
}

// #216 (Security): shells are matched by place, not name. Windows PowerShell and cmd under the Windows folder and PowerShell 7 under
// Program Files\PowerShell are verified shells (a bare prompt); any other shell-named image (WSL's System32\bash.exe, wsl.exe, git-bash,
// MSYS2, Cygwin, a pwsh elsewhere) is a shell of unknown contents; anything else is a program.
func TestWindowsShellsAreMatchedByPlace(t *testing.T) {
	win, err := windows.GetSystemWindowsDirectory()
	require.NoError(t, err)
	pf, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	require.NoError(t, err)
	for _, image := range []string{
		filepath.Join(win, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), filepath.Join(win, "System32", "cmd.exe"),
		filepath.Join(win, "SysWOW64", "cmd.exe"), filepath.Join(pf, "PowerShell", "7", "pwsh.exe"), strings.ToUpper(filepath.Join(win, "System32", "cmd.exe")),
	} {
		assert.True(t, verifiedWindowsShell(image), image)
	}
	for _, image := range []string{
		filepath.Join(win, "System32", "bash.exe"), filepath.Join(win, "System32", "wsl.exe"), filepath.Join(pf, "Git", "bin", "bash.exe"),
		filepath.Join(pf, "Git", "usr", "bin", "bash.exe"), `C:\msys64\usr\bin\zsh.exe`, `C:\cygwin64\bin\sh.exe`, `C:\tools\cmd.exe`,
		`C:\Users\x\scoop\apps\pwsh\current\pwsh.exe`, filepath.Join(win, "System32", "pwsh.exe"),
		// a program renamed like a shell in a user-writable place under the Windows folder (Security on #216)
		filepath.Join(win, "Temp", "cmd.exe"), filepath.Join(win, "Temp", "powershell.exe"), filepath.Join(win, "System32", "Tasks", "cmd.exe"),
		filepath.Join(pf, "PowerShell", "7", "sub", "pwsh.exe"),
	} {
		assert.False(t, verifiedWindowsShell(image), image)
		assert.True(t, shellNamed(image), "%s is named like a shell: unknown contents", image)
	}
	for _, image := range []string{`C:\Program Files\nodejs\node.exe`, `C:\x\claude.exe`, filepath.Join(win, "System32", "PING.EXE")} {
		assert.False(t, verifiedWindowsShell(image), image)
		assert.False(t, shellNamed(image), "%s is a program", image)
	}
	// the Terminal's console host by prefix only
	assert.True(t, consoleHostImage(filepath.Join(pf, "WindowsApps", "Microsoft.WindowsTerminal_1.22.11141.0_x64__8wekyb3d8bbwe", "OpenConsole.exe")))
	assert.False(t, consoleHostImage(`D:\x\WindowsApps\Microsoft.WindowsTerminal_1\OpenConsole.exe`), "a look-alike folder elsewhere")
}

// processTreeOf is the session's root and every process under it, image by image, for a failure's message.
func processTreeOf(b *PTYBackend, name string) string {
	b.mu.RLock()
	s, ok := b.sessions[name]
	b.mu.RUnlock()
	if !ok {
		return "(no session)"
	}
	wp, ok := s.proc.(*windowsPTY)
	if !ok {
		return "(not a ConPTY session)"
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err.Error()
	}
	defer windows.CloseHandle(snap)
	children := map[uint32][]windows.ProcessEntry32{}
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err := windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		children[e.ParentProcessID] = append(children[e.ParentProcessID], e)
	}
	var out []string
	var walk func(pid uint32, depth int)
	walk = func(pid uint32, depth int) {
		for _, c := range children[pid] {
			if depth > 8 {
				return
			}
			out = append(out, fmt.Sprintf("%s%s(%d)", strings.Repeat(">", depth+1), windows.UTF16ToString(c.ExeFile[:]), c.ProcessID))
			walk(c.ProcessID, depth+1)
		}
	}
	root := uint32(wp.cpty.Pid())
	out = append(out, fmt.Sprintf("root(%d)", root))
	walk(root, 0)
	return strings.Join(out, " ")
}
