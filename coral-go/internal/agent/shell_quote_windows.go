//go:build windows

package agent

import (
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/psquote"
)

// shellQuote returns s as one PowerShell word for the shell that runs the launch line
// (psQuote).
func shellQuote(s string) string { return psQuote(s, legacyNativeArgs()) }

// psQuote returns s as one PowerShell word: unchanged when every byte is in a small safe
// set, otherwise single-quoted. PowerShell expands nothing inside single quotes ($var, $(…)
// and backticks are literal; a double-quoted string would still expand them, #3362); an
// embedded ' or curly single quote is doubled (psquote, #3904). With legacy (Windows
// PowerShell 5.1, which escapes nothing when it builds a native program's command line) the
// value is first escaped for the program's argv parser (psquote.NativeArg: quotes, the
// backslashes before them and at the end); pwsh 7.3+ escapes it itself.
func psQuote(s string, legacy bool) string {
	if s == "" {
		return s
	}
	safe := true
	for i := 0; i < len(s); i++ {
		if !shellSafeByte(s[i]) {
			safe = false
			break
		}
	}
	if safe {
		return s
	}
	if legacy {
		s = psquote.NativeArg(s)
	}
	return psquote.Literal(s)
}

func shellSafeByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("-_./:=+,", c) >= 0
}

// ShellJoin builds a command line from parts. Every part is quoted as one word,
// except the parts in raw: shell syntax Coral built itself (a prompt file's
// $(Get-Content …), a $env: assignment), passed as they are. A part is raw only if
// the builder named it, never because of what it contains (#3362). The first quoted
// part that is the command gets PowerShell's call operator (&), since a bare quoted
// string is an expression, not a command.
func ShellJoin(parts []string, raw ...string) string {
	parts = unwrapBatchShim(resolveBareProgram(parts, raw), raw) // a .cmd would read the prompt again with cmd's rules
	notice := ""
	if p, r, n, changed := withoutPromptForBatch(parts, raw); changed {
		parts, raw, notice = p, r, n
		slog.Warn("agent CLI is a .cmd that is not npm's: it is started without the first message", "cli", filepath.Base(p[programIndex(p, r)]))
	}
	legacy := legacyNativeArgs()
	cmdArgs := map[string]string{} // a .cmd or .bat that is started as it is gets each argument with a < > & | or ^ in double quotes, which cmd.exe reads as plain text (#16207)
	batch := false
	if prog := programIndex(parts, raw); prog >= 0 && isBatchFile(parts[prog]) {
		batch = true
		for _, p := range parts[prog+1:] {
			if psquote.CmdUnsafe(p) { // cmd.exe would read part of it as a redirect or a second command: the line does not start the program (#16224)
				slog.Warn("agent CLI is a .cmd and an argument has characters cmd.exe would act on: not started", "cli", filepath.Base(parts[prog]))
				return "Write-Host " + psquote.Literal("Coral: "+filepath.Base(parts[prog])+" is a .cmd, and one of its arguments has characters cmd.exe would read as a redirect or a second command (a & | < > or ^ with a quote or a %), so it was not started. Point the CLI path at the .exe, or move the folder to a path without them.") + " -ForegroundColor Red"
			}
			if q, ok := psquote.CmdArg(p); ok {
				cmdArgs[p] = psquote.Literal(q)
			}
		}
	}
	line := joinQuoted(parts, raw, func(s string) string {
		if q, ok := cmdArgs[s]; ok {
			return q
		}
		return psQuote(s, legacy)
	}, true)
	if batch && !legacy && len(cmdArgs) > 0 { // PowerShell 7.3+ hands a .cmd its arguments as 5.1 does only in its 'Windows' mode; in 'Standard' it writes an embedded " as \" and cmd.exe would read the wrapped argument wrong (#16224)
		line = "$PSNativeCommandArgumentPassing = 'Windows'; " + line
	}
	if notice != "" {
		line = "Write-Host " + psquote.Literal(notice) + " -ForegroundColor Yellow; " + line
	}
	return line
}
