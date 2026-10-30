//go:build windows

package agent

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"github.com/subgentic/coral/internal/psquote"
)

// #3904: PowerShell itself reads each quoted word (psquote.Literal, used by shellQuote and
// shellQuoteLiteral) back unchanged, and the text after a quote
// character never runs. The word's characters are written as their code points, so the console's
// output encoding can't change what is compared.
func TestPSLiteralRoundTripsThroughPowerShell(t *testing.T) {
	ps, err := exec.LookPath("powershell.exe")
	if err != nil {
		if ps, err = exec.LookPath("pwsh.exe"); err != nil {
			if os.Getenv("CI") != "" {
				t.Fatal("no PowerShell on this CI runner: the round trip must run there, not skip")
			}
			t.Skip("no PowerShell on this host")
		}
	}
	words := []string{"it's", "O'Brien; Write-Output INJECTED", "$(Write-Output INJECTED)", "`$env:USERNAME"}
	for _, q := range []string{"\u2018", "\u2019", "\u201a", "\u201b"} {
		words = append(words, "Jane"+q+"s; Write-Output INJECTED", q, q+q+"x"+q, "C:\\Users\\Jane"+q+"s\\claude.exe")
	}
	// PowerShell runs in a folder of its own: after a full run a Microsoft\Windows\PowerShell\ModuleAnalysisCache was left under internal/agent (the working directory of a test)
	// and made every package that reads the tree a cache miss (#350). The tests here, and in literal_path, prompt_arg and prompt_flag_guard, start PowerShell.
	scratch := t.TempDir()
	for _, word := range words {
		script := "$s = " + psquote.Literal(word) + "; [string]::Join(',', [int[]][char[]]$s)"
		cmd := exec.Command(ps, "-NoProfile", "-NonInteractive", "-Command", script)
		cmd.Dir = scratch
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%q: powershell failed: %v\n%s", word, err, out)
		}
		var want []string
		for _, r := range word {
			want = append(want, strconv.Itoa(int(r)))
		}
		got := strings.TrimSpace(string(out))
		if got != strings.Join(want, ",") {
			t.Errorf("%q came back as %s, want %s", word, got, strings.Join(want, ","))
		}
		if strings.Contains(got, "INJECTED") {
			t.Errorf("%q: text after a quote ran", word)
		}
	}
}
