package ptymanager

import (
	"path/filepath"
	"runtime"
	"strings"
)

// The agent's own launcher on Windows (#391). A CLI installed with npm is a batch shim: PowerShell runs `claude` as `cmd.exe /d /s /c ""<the resolved claude.cmd>" <args>"`, so the node
// process that is the agent has a cmd.exe above it. That cmd is Coral's launcher, not a shell a person started, and it must not make every npm-installed agent need the Operator's
// "I know this is the agent" tick. It is recognised by its COMMAND LINE, never by its name: a cmd the person typed is interactive (`cmd`, `cmd /k`) or runs something else.
//
// The command line is compared here and then thrown away: it is never logged, never kept in a struct, never put in an answer (it can carry a prompt, a path or a secret).

// launcherCmdMaxLine bounds the command line that is read: a longer one is not read (the reader says no), so it counts as nested.
const launcherCmdMaxLine = 8192

// isLauncherCommandLine is whether cmdline is cmd.exe running exactly the resolved CLI cli (any extension), non-interactively:
//   - `cmd.exe`, then flags in any order from /d, /s, /q, then `/c` last;
//   - with /s, or when the text after /c starts and ends with a quote, exactly the outer pair of quotes is stripped;
//   - the first token of what remains (quoted or not) is the program: its path, cleaned, case-folded and symlink-resolved, equals the resolved CLI's, with or without the batch extension;
//   - extra arguments are fine, but any of & | < > ^ outside the quoted program path makes it NOT a match (`cmd /c "C:\x\claude.cmd" & bash` is not the launcher).
func isLauncherCommandLine(cmdline, cli string) bool {
	if cmdline == "" || cli == "" || len(cmdline) > launcherCmdMaxLine {
		return false
	}
	exe, rest := splitCmdToken(strings.TrimSpace(cmdline))
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(exe, "\\", "/")))
	if base != "cmd.exe" && base != "cmd" {
		return false
	}
	sawS := false
	for {
		rest = strings.TrimLeft(rest, " \t")
		if len(rest) < 2 || rest[0] != '/' {
			return false // no /c: interactive (`cmd`, `cmd /k`), or some other form
		}
		flag := strings.ToLower(rest[1:2])
		rest = rest[2:]
		if flag == "c" {
			break
		}
		if (flag != "d" && flag != "s" && flag != "q") || (rest != "" && rest[0] != ' ' && rest[0] != '\t') {
			return false
		}
		sawS = sawS || flag == "s"
	}
	text := strings.TrimSpace(rest)
	if (sawS || strings.HasPrefix(text, `"`)) && len(text) >= 2 && strings.HasPrefix(text, `"`) && strings.HasSuffix(text, `"`) {
		text = text[1 : len(text)-1]
	}
	prog, tail := splitCmdToken(strings.TrimLeft(text, " \t"))
	if prog == "" || strings.ContainsAny(tail, "&|<>^") {
		return false
	}
	if !strings.HasPrefix(strings.TrimLeft(text, " \t"), `"`) && strings.ContainsAny(prog, "&|<>^") {
		return false // an unquoted program glued to an operator
	}
	return sameCLIPath(prog, cli)
}

// splitCmdToken is the first token of s (quoted or not) and the rest after it.
func splitCmdToken(s string) (token, rest string) {
	s = strings.TrimLeft(s, " \t")
	if strings.HasPrefix(s, `"`) {
		if i := strings.Index(s[1:], `"`); i >= 0 {
			return s[1 : 1+i], s[2+i:]
		}
		return s[1:], ""
	}
	if i := strings.IndexAny(s, " \t"); i >= 0 {
		return s[:i], s[i:]
	}
	return s, ""
}

// sameCLIPath is whether two program paths name the same program: cleaned, case-folded (Windows paths), symlinks resolved when they can be, and the batch/exe extension ignored (the
// shim runs claude.cmd for a CLI resolved as claude, and the other way round).
func sameCLIPath(a, b string) bool {
	ca, cb := canonProgramPath(a), canonProgramPath(b)
	return ca != "" && ca == cb
}

func canonProgramPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	p = filepath.Clean(strings.ReplaceAll(p, "/", string(filepath.Separator)))
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	p = strings.ToLower(p)
	if runtime.GOOS != "windows" {
		p = filepath.Clean(p)
	}
	for _, ext := range []string{".cmd", ".bat", ".exe", ".com"} {
		if strings.HasSuffix(p, ext) {
			return strings.TrimSuffix(p, ext)
		}
	}
	return p
}
