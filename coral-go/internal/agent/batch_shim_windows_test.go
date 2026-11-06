//go:build windows

package agent

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
)

func shimExists(set ...string) func(string) bool {
	return func(p string) bool {
		for _, s := range set {
			if strings.EqualFold(s, p) {
				return true
			}
		}
		return false
	}
}

func noNode() (string, bool)    { return "", false }
func nodeFound() (string, bool) { return `C:\tools\node\node.exe`, true }
func TestAnNpmShimNamesTheProgramItRuns(t *testing.T) {
	const dir = `C:\npm`
	const head = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"
	const exe = `C:\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
	const js = `C:\npm\node_modules\pkg\cli.js`
	cases := []struct {
		name, shim string
		exists     func(string) bool
		node       func() (string, bool)
		want       []string
	}{
		{"a native program (the claude-code package)", head + "\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\"   %*\r\n", shimExists(exe), noNode, []string{exe}},
		{"node.exe beside the shim", head + "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\pkg\\cli.js\" %*\r\n",
			shimExists(`C:\npm\node.exe`, js), nodeFound, []string{`C:\npm\node.exe`, js}},
		{"node from PATH", head + "IF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\pkg\\cli.js\" %*\r\n",
			shimExists(`C:\tools\node\node.exe`, js), nodeFound, []string{`C:\tools\node\node.exe`, js}},
		{"an older shim with node and %~dp0", "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\pkg\\cli.js\" %*\r\n) ELSE (\r\n  node  \"%~dp0\\node_modules\\pkg\\cli.js\" %*\r\n)\r\n",
			shimExists(js), nodeFound, nil}, // two %* lines in an IF: not npm's current shape, left to the fallback
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := shimTarget(c.shim, dir, c.exists, c.node)
			if c.want == nil {
				assert.False(t, ok)
				return
			}
			require.True(t, ok)
			assert.Equal(t, c.want, got)
		})
	}
}

// A script that is not npm's, or names anything unsure, is never unwrapped: its text is not run by Coral.
func TestAShimThatIsNotNpmsIsNotUnwrapped(t *testing.T) {
	const dir = `C:\w`
	all := func(string) bool { return true }
	for name, shim := range map[string]string{
		"a wrapper that sets something first":  "@echo off\r\nset X=1\r\n\"C:\\w\\real.exe\" --flag %*\r\n",
		"no %*":                                "@echo off\r\n\"C:\\w\\real.exe\"\r\n",
		"a variable the shim did not set":      "@echo off\r\n\"%MYHOME%\\real.exe\" %*\r\n",
		"a command after the arguments":        "@echo off\r\n\"C:\\w\\real.exe\" %* & del x\r\n",
		"a character cmd acts on in the path":  "@echo off\r\n\"C:\\w\\a&b.exe\" %*\r\n",
		"a program that is not an exe":         "@echo off\r\n\"C:\\w\\real.cmd\" %*\r\n",
		"a script run by something that isn't": "@echo off\r\n\"C:\\w\\python.exe\" \"C:\\w\\x.js\" %*\r\n",
		"empty":                                "",
	} {
		t.Run(name, func(t *testing.T) {
			_, ok := shimTarget(shim, dir, all, nodeFound)
			assert.False(t, ok)
		})
	}
	_, ok := shimTarget("@echo off\r\n\"C:\\w\\real.exe\" %*\r\n", dir, shimExists(), nodeFound)
	assert.False(t, ok, "a program that is not there")
}

func TestOnlyAnAbsoluteBatchFileIsRead(t *testing.T) {
	assert.Equal(t, []string{`C:\x\a.exe`, "--p"}, unwrapBatchShim([]string{`C:\x\a.exe`, "--p"}))
	assert.Equal(t, []string{"claude.cmd", "--p"}, unwrapBatchShim([]string{"claude.cmd", "--p"}), "a bare name is not looked up from the current folder")
	assert.Equal(t, []string{filepath.Join(t.TempDir(), "gone.cmd"), "--p"}[1:], unwrapBatchShim([]string{filepath.Join(t.TempDir(), "gone.cmd"), "--p"})[1:])
}

// The launch line of a board agent whose CLI is an npm .cmd gives the program the prompt exactly as written:
// quotes, line breaks, < > & | ^ %, and more than cmd's 8191 characters. The shim here is npm's shape; its program is
// this test binary, which prints the arguments it gets (TestMain).
func TestAPromptReachesTheProgramOfAnNpmCmdShimWhole(t *testing.T) {
	native, err := os.Executable()
	require.NoError(t, err)
	dir := t.TempDir()
	shim := filepath.Join(dir, "claude.cmd")
	require.NoError(t, os.WriteFile(shim, []byte("@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\""+native+"\"   %*\r\n"), 0o600))

	shells := map[string]string{}
	if ps, err := exec.LookPath("powershell.exe"); err == nil {
		shells["powershell.exe"] = ps
	}
	if p := os.Getenv("CORAL_TEST_PWSH7"); p != "" { // a portable PowerShell 7 is named, not found on PATH
		shells["pwsh"] = p
	} else if ps, err := exec.LookPath("pwsh.exe"); err == nil {
		shells["pwsh"] = ps
	}
	require.NotEmpty(t, shells, "PowerShell required")
	if os.Getenv("CORAL_TEST_PWSH7") == "" {
		t.Log("CORAL_TEST_PWSH7 is not set: PowerShell 7 runs only if pwsh.exe is on PATH")
	}

	cases := []struct{ name, text string }{
		{"plain", "hello"},
		{"board", BuildBoardActionPrompt("diagnostic-board", "", "", nil, "")},
		{"quoted multi-line", "Read \"words\"\nKeep > and < and & literal."},
		{"cmd specials", "a & b | c ^ d < e > f %PATH% !x! \"q\" 100%"},
		{"long", strings.Repeat("plain words ", 800)},
		{"long multi-line with quotes and percent", strings.Repeat("say \"hi\" 50%\nthen <go> & stop\n", 300)},
	}
	for shellName, ps := range shells {
		t.Run(shellName, func(t *testing.T) {
			t.Setenv("CORAL_SHELL", ps)
			for _, c := range cases {
				t.Run(c.name, func(t *testing.T) {
					files := &launchFiles{}
					arg := files.promptArg("prompt489", "shim", "txt", "", c.text)
					line, err := files.done(ShellJoin([]string{shim, "--session-id", "s1", "--", arg}, arg))
					require.NoError(t, err)
					defer func() {
						for _, f := range files.made {
							_ = os.Remove(f)
						}
					}()
					script := filepath.Join(t.TempDir(), "probe.ps1")
					require.NoError(t, os.WriteFile(script, []byte("\ufeff"+line+"\nexit $LASTEXITCODE\n"), 0o600))
					cmd := consoletest.HiddenCommand(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
					var out bytes.Buffer
					cmd.Stdout, cmd.Stderr, cmd.Dir = &out, &out, dir
					cmd.Env = append(os.Environ(), argvEchoEnv+"=1")
					require.NoError(t, cmd.Start())
					timer := time.AfterFunc(30*time.Second, func() { _ = cmd.Process.Kill() })
					defer timer.Stop()
					runErr := cmd.Wait()
					got := strings.ReplaceAll(out.String(), "\r\n", "\n")
					want := "[--session-id]\n[s1]\n[--]\n[" + c.text + "]\n--\n"
					assert.NoError(t, runErr, got[:min(len(got), 200)])
					assert.True(t, got == want, "the arguments the program got: %q", got[:min(len(got), 200)])
				})
			}
		})
	}
}
