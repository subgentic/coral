package agent

import (
	"regexp"
	"strings"
)

// MissingCommandIn reports whether out holds a shell's "no such command" error for binary. It is the backup under the CLI checks (#353): the refusal before the launch line is typed is the
// main guard, and this reads the error a typed line leaves in the pane. The wordings, with where each comes from:
//   - Windows PowerShell 5.1: "The term 'codex' is not recognized as the name of a cmdlet, function, script file, or operable program."
//   - PowerShell 7: "The term 'codex' is not recognized as a name of a cmdlet, function, script file, or executable program." (PowerShell's own DiscoveryExceptions.resx,
//     https://github.com/PowerShell/PowerShell/blob/master/src/System.Management.Automation/resources/DiscoveryExceptions.resx, key CommandNotFoundException)
//   - cmd: "'codex' is not recognized as an internal or external command, operable program or batch file."
//   - POSIX shells: "bash: codex: command not found", "zsh: command not found: codex", "sh: 1: codex: not found".
//
// These are English: a Windows or a shell in another language words them differently and the backup does not match. A pane narrower than the sentence wraps it, so the PowerShell and cmd
// phrases are matched on the text with its whitespace and line breaks collapsed. An error about another command does not count.
func MissingCommandIn(out, binary string) bool {
	b := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(binary)), ".exe")
	if b == "" || out == "" {
		return false
	}
	q := regexp.QuoteMeta(b)
	name := `['"` + "`" + `]?` + q + `(?:\.(?:exe|cmd|bat|ps1))?['"` + "`" + `]?`
	low := strings.ToLower(out)
	collapsed := strings.Join(strings.Fields(low), " ")
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`the term ` + name + ` is not recognized as (?:the|a) name of a`),
		regexp.MustCompile(`(?:^| )` + name + ` is not recognized as an internal or external command`),
	} {
		if re.MatchString(collapsed) {
			return true
		}
	}
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`(?m)^(?:[^\n:]*:\s*)*` + q + `: (?:command )?not found\s*$`),
		regexp.MustCompile(`(?m)^[^\n]*command not found: ` + q + `\s*$`),
	} {
		if re.MatchString(low) {
			return true
		}
	}
	return false
}

// answerLines is the most of the screen above the bottom prompt that is read as the shell's latest answer: a PowerShell error, the longest, is the
// sentence (wrapped on a narrow pane) and its "Check the spelling" line.
const answerLines = 12

// psTrailer is a line PowerShell prints under a command's error: its position ("At line:1 char:1") and the lines that start with "+" (the
// command, its underline, CategoryInfo, FullyQualifiedErrorId).
var psTrailer = regexp.MustCompile(`^\s*(?:At line:\d+ char:\d+|\+.*)$`)

// MissingCommandAtBottom reports whether the shell's LATEST answer, right above the prompt at the bottom of screen, is its "no such command"
// error for binary (#353's safety net; the coral-go-team Security's INFO on #173). Coral's quiet launch clears the screen, so the line it typed is
// not there to anchor on; the bottom is: the prompt the shell came back to is the last line, and the error must END the block of lines right
// above it (PowerShell's position and "+" lines under the error are skipped, blank lines end the block). The same words higher up, or followed
// by any other output or a typed command, are not the shell's latest answer and do not count.
func MissingCommandAtBottom(screen, binary string) bool {
	b := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(binary)), ".exe")
	if b == "" {
		return false
	}
	lines := strings.Split(strings.ReplaceAll(screen, "\r\n", "\n"), "\n")
	trimBlank := func() {
		for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
			lines = lines[:len(lines)-1]
		}
	}
	trimBlank()
	if len(lines) < 2 {
		return false // a prompt alone, or nothing: no answer
	}
	lines = lines[:len(lines)-1] // the prompt the shell came back to
	trimBlank()
	for len(lines) > 0 && psTrailer.MatchString(lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	trimBlank()
	start := len(lines)
	for start > 0 && len(lines)-start < answerLines && strings.TrimSpace(lines[start-1]) != "" {
		start--
	}
	block := lines[start:]
	if len(block) == 0 {
		return false
	}
	q := regexp.QuoteMeta(b)
	name := `['"` + "`" + `]?` + q + `(?:\.(?:exe|cmd|bat|ps1))?['"` + "`" + `]?`
	// A POSIX shell's error is one line: the block's last.
	last := strings.ToLower(strings.TrimSpace(block[len(block)-1]))
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`^(?:[^:]*:\s*)*` + q + `: (?:command )?not found$`),
		regexp.MustCompile(`command not found: ` + q + `$`),
	} {
		if re.MatchString(last) {
			return true
		}
	}
	// PowerShell's and cmd's are sentences a narrow pane wraps: matched on the block with its line breaks collapsed, and they must END it.
	collapsed := strings.Join(strings.Fields(strings.ToLower(strings.Join(block, " "))), " ")
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`the term ` + name + ` is not recognized as (?:the|a) name of a cmdlet, function, script file, or (?:operable|executable) program\.(?: check the spelling of the name, or if a path was included, verify that the path is correct and try again\.)?$`),
		regexp.MustCompile(`(?:^| )` + name + ` is not recognized as an internal or external command, operable program or batch file\.$`),
	} {
		if re.MatchString(collapsed) {
			return true
		}
	}
	return false
}
