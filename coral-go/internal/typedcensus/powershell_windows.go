//go:build windows

package typedcensus

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/subgentic/coral/internal/board"
)

// psCheck parses each line with PowerShell's own parser and lists, per line, the commands it would run and the sub-expressions in it;
// then the openers that resolve to a command here. It is a file, run with -File: no line is ever put on PowerShell's command line.
const psCheck = `
param([string]$In)
$lines = Get-Content -Raw -Encoding UTF8 $In | ConvertFrom-Json
$out = foreach ($l in $lines.lines) {
  $tok = $null; $err = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($l, [ref]$tok, [ref]$err)
  $cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { [string]$_.GetCommandName() })
  $subs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.SubExpressionAst] -or $n -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or $n -is [System.Management.Automation.Language.ParenExpressionAst] -or $n -is [System.Management.Automation.Language.ArrayExpressionAst] }, $true)).Count
  [pscustomobject]@{ line = $l; commands = $cmds; subs = $subs }
}
$found = @($lines.openers | Where-Object { Get-Command -Name $_ -ErrorAction SilentlyContinue })
[pscustomobject]@{ results = @($out); openers = $found } | ConvertTo-Json -Depth 5 -Compress
`

func checkPowerShell(t *testing.T, cases []Case) {
	t.Helper()
	// Windows PowerShell by its place in the system folder, never found on PATH (Security on goal #7).
	sys, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatalf("the system folder: %v", err)
	}
	ps := filepath.Join(sys, "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(ps); err != nil {
		t.Log("no Windows PowerShell: the PowerShell parse check is skipped")
		return
	}
	dir := t.TempDir()
	var lines []string
	for _, c := range cases {
		lines = append(lines, c.Plain, c.Hostile)
	}
	in, _ := json.Marshal(map[string]any{"lines": lines, "openers": board.TypedOpeners})
	if err := os.WriteFile(filepath.Join(dir, "in.json"), in, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "check.ps1"), []byte(psCheck), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(dir, "check.ps1"), "-In", filepath.Join(dir, "in.json"))
	// No console of its own: a test must never open a window on the person's desktop (#381).
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("the PowerShell parse check did not run: %v", err)
	}
	var got struct {
		Results []struct {
			Line     string   `json:"line"`
			Commands []string `json:"commands"`
			Subs     int      `json:"subs"`
		} `json:"results"`
		Openers []string `json:"openers"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("the PowerShell parse check's answer: %v: %s", err, out)
	}
	for _, r := range got.Results {
		for _, c := range r.Commands {
			if c != "" && !isOpener(c) {
				t.Errorf("PowerShell would run the command %q in the typed line %q", c, r.Line)
			}
		}
		if r.Subs > 0 {
			t.Errorf("PowerShell finds %d sub-expressions (a part it would evaluate) in the typed line %q", r.Subs, r.Line)
		}
	}
	if len(got.Openers) > 0 {
		t.Errorf("these openers are a command in PowerShell here: %s", strings.Join(got.Openers, ", "))
	}
}
