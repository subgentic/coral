package agent

import (
	"regexp"
	"strings"
)

// MissingCommandIn reports whether out holds a shell's "no such command" error for binary: PowerShell's ("The term 'codex' is not recognized as the name of a cmdlet,
// function, script file, or operable program"), cmd's ("'codex' is not recognized as an internal or external command"), and the POSIX shells' ("codex: command not found",
// "zsh: command not found: codex", "sh: 1: codex: not found"). It is the safety net under the CLI checks (#353): a launch line typed anyway leaves the shell's own error in
// the pane. An error about another command does not count.
func MissingCommandIn(out, binary string) bool {
	b := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(binary)), ".exe")
	if b == "" || out == "" {
		return false
	}
	q := regexp.QuoteMeta(b)
	name := `['"` + "`" + `]?` + q + `(?:\.(?:exe|cmd|bat|ps1))?['"` + "`" + `]?`
	res := []*regexp.Regexp{
		regexp.MustCompile(`the term ` + name + ` is not recognized as the name of a`),
		regexp.MustCompile(`(?m)^\s*` + name + ` is not recognized as an internal or external command`),
		regexp.MustCompile(`(?m)^(?:[^\n:]*:\s*)*` + q + `: (?:command )?not found\s*$`),
		regexp.MustCompile(`(?m)^[^\n]*command not found: ` + q + `\s*$`),
	}
	low := strings.ToLower(out)
	for _, re := range res {
		if re.MatchString(low) {
			return true
		}
	}
	return false
}
