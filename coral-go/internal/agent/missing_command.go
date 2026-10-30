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

// launchAnswerLines is how much of the screen under Coral's launch line is the shell's answer to it: a PowerShell error, the longest, is the
// sentence (wrapped on a narrow pane), its position and its category lines.
const launchAnswerLines = 12

// AfterLaunchLine is the screen's text under the last line that sets CORAL_SESSION_ID to sessionID, at most launchAnswerLines lines of it.
// Coral's launch line sets it (coralEnvPrefix: "export ... CORAL_SESSION_ID=<id>" or "$env:CORAL_SESSION_ID = '<id>'"), so that line is the
// launch, and what follows it is the shell's answer, not an agent's later output or a transcript printed above it. A line that only shows the
// id (an echo of it) is not the launch. ok is false when no line sets it (the screen was cleared, scrolled past it or redrawn): then nothing on
// the screen can be tied to the launch.
func AfterLaunchLine(screen, sessionID string) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	sets := regexp.MustCompile(`CORAL_SESSION_ID\s*=\s*['"]?` + regexp.QuoteMeta(sessionID))
	all := sets.FindAllStringIndex(screen, -1)
	if len(all) == 0 {
		return "", false
	}
	rest := screen[all[len(all)-1][0]:]
	nl := strings.IndexByte(rest, '\n')
	if nl < 0 {
		return "", true // the launch line is the last line: no answer yet
	}
	lines := strings.SplitN(rest[nl+1:], "\n", launchAnswerLines+1)
	if len(lines) > launchAnswerLines {
		lines = lines[:launchAnswerLines]
	}
	return strings.Join(lines, "\n"), true
}
