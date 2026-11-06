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

	"github.com/subgentic/coral/internal/consoletest"
)

// Diagnostic for #13881: compare a native CLI and a batch shim through the same
// promptArg/ShellJoin path, in both PowerShell argument-passing modes. The shim
// writes a marker before forwarding, distinguishing invocation failure from argv
// corruption inside a launcher. All content is synthetic, never a session token.
func TestWindowsBoardPromptLauncherComparison(t *testing.T) {
	native, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	shim := filepath.Join(dir, "cli.cmd")
	marker := filepath.Join(dir, "started")
	if err := os.WriteFile(shim, []byte("@echo off\r\ntype nul > \""+marker+"\"\r\n\""+native+"\" %*\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, shell := range []string{"powershell.exe", "pwsh.exe"} {
		ps, err := exec.LookPath(shell)
		if err != nil {
			continue
		}
		found = true
		t.Run(shell, func(t *testing.T) {
			t.Setenv("CORAL_SHELL", ps)
			cases := []struct{ name, text string }{
				{"plain", "hello"},
				{"board", BuildBoardActionPrompt("diagnostic-board", "", "", nil, "")},
				{"quoted-multiline", "Read \"words\"\nKeep > and < and & literal."},
				{"long", strings.Repeat("plain words ", 800)},
			}
			for _, c := range cases {
				for _, kind := range []string{"native", "cmd"} {
					t.Run(c.name+"/"+kind, func(t *testing.T) {
						_ = os.Remove(marker)
						files := &launchFiles{}
						arg := files.promptArg("prompt13881", "diagnostic", "txt", "", c.text)
						program := native
						if kind == "cmd" {
							program = shim
						}
						line, err := files.done(ShellJoin([]string{program, arg}, arg))
						if err != nil {
							t.Fatal(err)
						}
						defer func() {
							for _, f := range files.made {
								_ = os.Remove(f)
							}
						}()
						script := filepath.Join(t.TempDir(), "probe.ps1")
						if err := os.WriteFile(script, []byte("\ufeff"+line+"\nexit $LASTEXITCODE\n"), 0600); err != nil {
							t.Fatal(err)
						}
						cmd := consoletest.HiddenCommand(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
						var output bytes.Buffer
						cmd.Stdout = &output
						cmd.Stderr = &output
						cmd.Dir = dir
						cmd.Env = append(os.Environ(), argvEchoEnv+"=1")
						if err := cmd.Start(); err != nil {
							t.Fatal(err)
						}
						timer := time.AfterFunc(15*time.Second, func() { _ = cmd.Process.Kill() })
						defer timer.Stop()
						runErr := cmd.Wait()
						out := output.Bytes()
						got := strings.ReplaceAll(string(out), "\r\n", "\n")
						want := "[" + c.text + "]\n--\n"
						_, markErr := os.Stat(marker)
						t.Logf("chars=%d shim_started=%v exit=%v argv_exact=%v output_prefix=%q", len(c.text), markErr == nil, runErr, got == want, got[:min(len(got), 180)])
						if kind == "native" && (runErr != nil || got != want) {
							t.Errorf("native launch/prompt round trip failed")
						}
					})
				}
			}
		})
	}
	if !found {
		t.Fatal("PowerShell required for Windows launch comparison")
	}
}
