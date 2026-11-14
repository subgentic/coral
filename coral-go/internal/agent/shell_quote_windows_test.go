//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/psquote"
)

// #3362: PowerShell expands $var, $(…) and backticks inside double quotes, so anything
// not plainly safe is single-quoted; only the parts a builder names are raw.
func TestShellQuotePowerShell(t *testing.T) {
	t.Setenv("CORAL_SHELL", "powershell.exe")
	for in, want := range map[string]string{
		"claude":        "claude",
		"--model":       "--model",
		"a b":           "'a b'",
		"$(calc)":       "'$(calc)'",
		"$env:USERNAME": "'$env:USERNAME'",
		"`calc`":        "'`calc`'",
		"it's":          "'it''s'",
		`say "hi"`:      `'say \"hi\"'`,
		"x; calc":       "'x; calc'",
		// #3904: the curly single quotes are doubled too, in a flag and in a path.
		"--name=Jane\u2019s; calc":           "'--name=Jane\u2019\u2019s; calc'",
		"x\u2018; calc":                      "'x\u2018\u2018; calc'",
		"\u201a$(calc)\u201b":                "'\u201a\u201a$(calc)\u201b\u201b'",
		"C:\\Users\\Jane\u2019s\\claude.exe": "'C:\\Users\\Jane\u2019\u2019s\\claude.exe'",
	} {
		assert.Equal(t, want, shellQuote(in), "%q", in)
	}
	// #12: Windows PowerShell 5.1 escapes nothing for the program's argv, so the line does
	// (psquote.NativeArg): the backslash before an escaped quote, and a trailing backslash.
	const toml = `hooks.Stop=[{hooks=[{type="command",command="\"C:/Program Files (x86)/Coral/coral-hook-agentic-state.exe\""}]}]`
	assert.Equal(t, `'hooks.Stop=[{hooks=[{type=\"command\",command=\"\\\"C:/Program Files (x86)/Coral/coral-hook-agentic-state.exe\\\"\"}]}]'`, shellQuote(toml))
	assert.Equal(t, `'C:\dir with space\\'`, shellQuote(`C:\dir with space\`))
	// pwsh 7.3+ escapes each argument itself: the value is only quoted for PowerShell.
	pwsh := filepath.Join(t.TempDir(), "pwsh.exe") // a stand-in: CORAL_SHELL must name a real file (#26 G1A)
	if err := os.WriteFile(pwsh, []byte("MZ"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CORAL_SHELL", pwsh)
	assert.Equal(t, "'"+toml+"'", shellQuote(toml))
	assert.Equal(t, `'say "hi"'`, shellQuote(`say "hi"`))
	// A prompt file is read back as it is, whichever PowerShell: promptArg wrote it escaped for
	// 5.1 when 5.1 runs the line (#29).
	assert.Equal(t, `"$(Get-Content -Raw -Encoding UTF8 -LiteralPath 'p.txt')"`, FormatPromptFileArg("p.txt"))
	t.Setenv("CORAL_SHELL", "powershell.exe")
	assert.Equal(t, `"$(Get-Content -Raw -Encoding UTF8 -LiteralPath 'p.txt')"`, FormatPromptFileArg("p.txt"))

	raw := `"$((Get-Content -Raw 'C:\t\p.txt') -replace '"', '\"')"`
	assert.Equal(t, `& 'C:\Program Files\claude.exe' '$(calc)' `+raw,
		ShellJoin([]string{`C:\Program Files\claude.exe`, "$(calc)", raw}, raw))
}

// #16207: a .cmd that is not npm's shim is started as it is, and cmd.exe reads each argument: the -c value of Coral's hook trust has < > in its key, so it goes in double quotes (plain text to cmd), written as it is and not with NativeArg's \".
func TestShellJoinQuotesCmdMetacharactersForABatchProgram(t *testing.T) {
	t.Setenv("CORAL_SHELL", "powershell.exe")
	value := codexHookTrustArgs("windows", "& 'C:/Coral/coral-hook-agentic-state.exe'")[1]
	line := ShellJoin([]string{`C:\tools\codex.cmd`, "-c", value})
	assert.Equal(t, `& 'C:\tools\codex.cmd' -c `+psquote.Literal(`"`+value+`"`), line)
	// a program that is not a batch file keeps the old rule
	assert.Equal(t, `& 'C:\tools\codex.exe' -c `+psquote.Literal(value), ShellJoin([]string{`C:\tools\codex.exe`, "-c", value}))
}
