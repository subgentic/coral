//go:build windows

package agent

import (
	"bytes"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/consoletest"
	"github.com/subgentic/coral/internal/psquote"
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
	assert.Equal(t, []string{`C:\x\a.exe`, "--p"}, unwrapBatchShim([]string{`C:\x\a.exe`, "--p"}, nil))
	assert.Equal(t, []string{"claude.cmd", "--p"}, unwrapBatchShim([]string{"claude.cmd", "--p"}, nil), "a bare name is not looked up from the current folder")
	assert.Equal(t, []string{filepath.Join(t.TempDir(), "gone.cmd"), "--p"}[1:], unwrapBatchShim([]string{filepath.Join(t.TempDir(), "gone.cmd"), "--p"}, nil)[1:])
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

// A .cmd that is not npm's cannot be unwrapped, and cmd.exe would read the prompt again: the agent is started without the prompt, and the pane says so.
func TestAWrapperThatIsNotNpmsStartsWithoutThePromptAndSaysSo(t *testing.T) {
	native, err := os.Executable()
	require.NoError(t, err)
	dir := t.TempDir()
	wrapper := filepath.Join(dir, "my cli.cmd")
	require.NoError(t, os.WriteFile(wrapper, []byte("@echo off\r\n\""+native+"\" --wrapped %*\r\n"), 0o600))
	for shellName, ps := range map[string]string{"powershell.exe": mustLook(t, "powershell.exe")} {
		t.Run(shellName, func(t *testing.T) {
			t.Setenv("CORAL_SHELL", ps)
			text := "Read \"words\"\nKeep > and < and & literal."
			files := &launchFiles{}
			arg := files.promptArg("prompt489", "wrapper", "txt", "", text)
			line, err := files.done(ShellJoin([]string{wrapper, "--session-id", "s1", "--", arg}, arg))
			require.NoError(t, err)
			defer func() {
				for _, f := range files.made {
					_ = os.Remove(f)
				}
			}()
			assert.NotContains(t, line, "Get-Content -Raw -Encoding UTF8 -LiteralPath '"+files.made[0], "the prompt file is not on the line")
			script := filepath.Join(t.TempDir(), "probe.ps1")
			require.NoError(t, os.WriteFile(script, []byte("\ufeff"+line+"\nexit $LASTEXITCODE\n"), 0o600))
			cmd := consoletest.HiddenCommand(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
			var out bytes.Buffer
			cmd.Stdout, cmd.Stderr, cmd.Dir = &out, &out, dir
			cmd.Env = append(os.Environ(), argvEchoEnv+"=1")
			require.NoError(t, cmd.Run(), out.String())
			got := strings.ReplaceAll(out.String(), "\r\n", "\n")
			assert.Contains(t, got, "Coral: my cli.cmd is a .cmd wrapper Coral cannot read")
			assert.True(t, strings.HasSuffix(got, "[--wrapped]\n[--session-id]\n[s1]\n--\n"), "the program got its options and no prompt: %q", got)
		})
	}
}

func mustLook(t *testing.T, name string) string {
	t.Helper()
	p, err := exec.LookPath(name)
	require.NoError(t, err)
	return p
}

// The launch line of an agent has the environment's syntax before the program: the shim is found past it.
func TestTheLaunchLineOfAnAgentWhoseCLIIsAnNpmShimRunsTheShimsProgram(t *testing.T) {
	native, err := os.Executable()
	require.NoError(t, err)
	dir := t.TempDir()
	npm := filepath.Join(dir, "claude.cmd")
	require.NoError(t, os.WriteFile(npm, []byte("@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n\""+native+"\"   %*\r\n"), 0o600))
	other := filepath.Join(dir, "wrapped.cmd")
	require.NoError(t, os.WriteFile(other, []byte("@echo off\r\n\""+native+"\" --wrapped %*\r\n"), 0o600))
	params := func(cli string) LaunchParams {
		return LaunchParams{CLIPath: cli, SessionID: "11111111-2222-3333-4444-555555555555", BoardName: "b"}
	}

	line, err := (&ClaudeAgent{}).LaunchCommand(params(npm))
	require.NoError(t, err)
	assert.NotContains(t, line, "claude.cmd", "the shim is not run")
	assert.Contains(t, line, "Get-Content -Raw -Encoding UTF8", "the prompt is passed, from its file")
	assert.Contains(t, line, "& "+psquote.Literal(native)+" --session-id", "the program the shim names is")

	line, err = (&ClaudeAgent{}).LaunchCommand(params(other))
	require.NoError(t, err)
	assert.NotContains(t, line, "Get-Content -Raw -Encoding UTF8 -LiteralPath", "no prompt goes to a wrapper that is not npm's")
	assert.Contains(t, line, "Write-Host 'Coral: wrapped.cmd is a .cmd wrapper")
}

// A CLI named without a folder (claude) is the file PowerShell finds for it on PATH, which for an npm install is its .cmd: it is treated as that file, and a relative path to a .cmd is never run with the prompt.
func TestABareOrRelativeCLINameThatIsACmdIsNotRunWithThePrompt(t *testing.T) {
	native, err := os.Executable()
	require.NoError(t, err)
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "claude.cmd"), []byte("@ECHO off\r\nSETLOCAL\r\n\""+native+"\"   %*\r\n"), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "other.cmd"), []byte("@echo off\r\n\""+native+"\" --wrapped %*\r\n"), 0o600))
	t.Setenv("PATH", dir+";"+os.Getenv("PATH"))
	params := func(cli string) LaunchParams {
		return LaunchParams{CLIPath: cli, SessionID: "11111111-2222-3333-4444-555555555555", BoardName: "b"}
	}
	for _, name := range []string{"claude", "claude.cmd"} {
		line, err := (&ClaudeAgent{}).LaunchCommand(params(name))
		require.NoError(t, err)
		assert.Contains(t, line, "& "+psquote.Literal(native)+" --session-id", name+": the program the shim names runs")
		assert.Contains(t, line, "Get-Content -Raw -Encoding UTF8", name+": with the prompt")
	}
	for _, name := range []string{"other", `.\other.cmd`, `..\` + filepath.Base(dir) + `\other.cmd`} {
		line, err := (&ClaudeAgent{}).LaunchCommand(params(name))
		require.NoError(t, err)
		assert.NotContains(t, line, "Get-Content -Raw -Encoding UTF8 -LiteralPath", name+": no prompt")
		assert.Contains(t, line, "Write-Host 'Coral: other.cmd is a .cmd wrapper", name)
	}
}

// The log line of a launch started without its prompt names the CLI by its file name only, not the folder it is in.
func TestTheLogLineOfALaunchWithoutItsPromptNamesOnlyTheFile(t *testing.T) {
	var logged bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	t.Cleanup(func() { slog.SetDefault(old) })

	dir := filepath.Join(t.TempDir(), "private folder name")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	wrapper := filepath.Join(dir, "other.cmd")
	require.NoError(t, os.WriteFile(wrapper, []byte("@echo off\r\nrealcli --wrapped %*\r\n"), 0o600))
	files := &launchFiles{}
	arg := files.promptArg("prompt489", "log", "txt", "", "hello")
	_, err := files.done(ShellJoin([]string{wrapper, "--", arg}, arg))
	require.NoError(t, err)
	defer func() {
		for _, f := range files.made {
			_ = os.Remove(f)
		}
	}()
	assert.Contains(t, logged.String(), "started without the first message")
	assert.Contains(t, logged.String(), "cli=other.cmd")
	assert.NotContains(t, logged.String(), "private folder name")
	assert.NotContains(t, logged.String(), dir)
}
