package ptymanager

import (
	"path"
	"strings"
)

// Coral's own handoff PowerShell (#391). A long or quiet launch line is written to a coral-command-<digits>.ps1 and typed as `& <powershell> -NoProfile -ExecutionPolicy Bypass -File <script>`, so
// the launcher cmd (and the agent below it) has that PowerShell above it. Coral keeps the path of the script it wrote for the session's launch, so that PowerShell is recognised by its
// COMMAND LINE: exactly those flags and exactly that path, nothing else. A ConPTY session cannot outlive Coral, so the path is always known for a live launch; when it is not (a line typed as
// it is, or nothing recorded) nothing matches and the PowerShell stays a nested shell. The command line is compared and dropped, like the launcher cmd's.

// isHandoffCommandLine is whether cmdline is a PowerShell run as `-NoProfile -ExecutionPolicy Bypass -File <script>` with <script> the very file Coral wrote (cleaned, case-folded, the
// folder's short names expanded), and no other token.
func isHandoffCommandLine(cmdline, script string) bool {
	if cmdline == "" || script == "" || len(cmdline) > launcherCmdMaxLine {
		return false
	}
	var toks []string
	rest := strings.TrimSpace(cmdline)
	for rest != "" {
		var t string
		t, rest = splitCmdToken(rest)
		toks = append(toks, t)
		rest = strings.TrimSpace(rest)
		if len(toks) > 6 {
			return false
		}
	}
	if len(toks) != 6 {
		return false
	}
	base := strings.ToLower(path.Base(strings.ReplaceAll(toks[0], "\\", "/")))
	if base != "powershell.exe" && base != "powershell" && base != "pwsh.exe" && base != "pwsh" {
		return false
	}
	for i, want := range []string{"-noprofile", "-executionpolicy", "bypass", "-file"} {
		if strings.ToLower(toks[i+1]) != want {
			return false
		}
	}
	return sameScriptPath(toks[5], script)
}

// sameScriptPath is whether two paths name the same file by their text, on any OS: both separators read as "/", cleaned, case-folded, the folder's short (8.3) names expanded (the file itself is already gone: the script removes itself).
func sameScriptPath(a, b string) bool {
	canon := func(p string) string {
		p = strings.TrimSpace(p)
		if p == "" || strings.ContainsAny(p, "\"*?<>|") {
			return ""
		}
		// Windows paths are read the same on every OS (the table is run on macOS and Linux too): both separators are "/", the path is cleaned as text, and the folder's short names are
		// expanded where there are any (Windows).
		p = path.Clean(strings.ReplaceAll(p, "\\", "/"))
		return strings.ToLower(path.Join(expandShortDir(path.Dir(p)), path.Base(p)))
	}
	ca, cb := canon(a), canon(b)
	return ca != "" && ca == cb
}

// onlyChildIsLauncher is whether pid's only child (a console host aside) is a verified cmd running the resolved CLI as the launcher.
func onlyChildIsLauncher(src procSource, pid int, cli string) bool {
	var only []int
	for _, k := range src.children(pid) {
		if src.info(k).kind != kindConsoleHost {
			only = append(only, k)
		}
	}
	if len(only) != 1 {
		return false
	}
	p := src.info(only[0])
	if !p.known || p.kind != kindVerifiedShell || p.name != "cmd" {
		return false
	}
	line, ok := src.commandLine(only[0])
	return ok && isLauncherCommandLine(line, cli)
}
