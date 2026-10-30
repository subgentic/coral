package agent

import (
	"regexp"
	"strings"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// StepPrintArgs is the argument list for a one-shot, non-interactive run of agentType's CLI on prompt (a workflow
// step), as real argv. The prompt can carry earlier steps' output and board text, so it is placed where the CLI
// can only read it as the prompt (#36, Security's W1), whatever it starts with:
//
//   - codex: "exec ... -" with the prompt on stdin (codex exec reads its instructions from stdin for "-"; it takes
//     no --print);
//   - agy: --print is its own flag and takes the next argument as its value, so the prompt is the last pair and
//     nothing follows it, with --disable-slash-commands before it;
//   - pi and any other CLI: --print and the prompt as the last argument, a leading newline in front of one that
//     starts with "-" or "@" (guardPositionalPrompt).
//
// stdin is the prompt for a CLI that reads it there, "" otherwise. flags and modelArgs go before the prompt. Claude
// has its own path (PrintArgs, the prompt on stdin).
func StepPrintArgs(agentType string, flags, modelArgs []string, prompt string) (args []string, stdin string) {
	switch agentType {
	case at.Codex:
		args = append([]string{"exec"}, modelArgs...)
		args = append(args, flags...)
		return append(args, "-"), prompt
	case at.Agy:
		args = append(append([]string{}, modelArgs...), flags...)
		// --disable-slash-commands: agy expands slash commands and skills in the prompt, and a step prompt carries
		// earlier steps' output and board text; whitespace in front does not stop it.
		return append(args, "--disable-slash-commands", "--print", prompt), ""
	case at.Pi:
		// An unattended one-shot run (#11105): no session kept, and the repository's own Pi files are not trusted. The configured flags go through piStepFlags: an --approve or a session flag cannot undo that.
		// --no-session and --no-approve come last, so that a flag that slipped past the filter is never the one that wins.
		args = append([]string{"--print"}, modelArgs...)
		args = append(args, piStepFlags(flags)...)
		args = append(args, "--no-session", "--no-approve")
		return append(args, guardPositionalPrompt(prompt)), ""
	default:
		args = append([]string{"--print"}, modelArgs...)
		args = append(args, flags...)
		return append(args, guardPositionalPrompt(prompt)), ""
	}
}

// piStepFlags are a Pi step's configured flags without the ones that would undo what a step is: trusting the repository's Pi files and keeping or resuming a session (see dropsTrustOrSession).
func piStepFlags(flags []string) []string {
	out := make([]string, 0, len(flags))
	for i := 0; i < len(flags); i++ {
		f := flags[i]
		switch f {
		case "--session", "--session-id", "--session-dir", "--fork":
			if i+1 < len(flags) && !strings.HasPrefix(flags[i+1], "-") {
				i++ // its value
			}
			continue
		}
		if dropsTrustOrSession(f) || f == "--no-approve" || f == "--no-session" {
			continue // ours go last, once
		}
		out = append(out, f)
	}
	return out
}

// trustFlagValueForms are the flags that undo a step or a job whichever way they are written: --name=value is dropped as --name is.
var trustFlagValueForms = []string{"--approve=", "--continue=", "--resume=", "--session=", "--session-id=", "--session-dir=", "--fork="}

// dropsTrustOrSession reports whether a flag is one that trusts the repository's own Pi files (--approve, -a), or keeps or resumes a session (--continue, -c, --resume, -r), in the exact form, as
// --name=value, or inside a short-flag bundle holding an a, c or r (-ac, -nr: Pi's own bundles such as -nc are lost with them, which is the safe side).
func dropsTrustOrSession(f string) bool {
	switch f {
	case "--approve", "--continue", "--resume":
		return true
	}
	for _, p := range trustFlagValueForms {
		if strings.HasPrefix(f, p) {
			return true
		}
	}
	if len(f) >= 2 && f[0] == '-' && f[1] != '-' {
		letters := true
		for _, r := range f[1:] {
			if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
				letters = false
				break
			}
		}
		return letters && strings.ContainsAny(strings.ToLower(f[1:]), "acr")
	}
	return false
}

// piToolNameR is a plain tool name or pattern as Pi's --tools takes it: letters, digits, _ - * and +; never a flag (a leading "-") and never a list or a space.
var piToolNameR = regexp.MustCompile(`^[A-Za-z0-9_*][A-Za-z0-9_*+-]{0,63}$`)

// PiToolFlags is "--tools a,b" for a step's configured tool allowlist, with every entry that is not a plain tool name dropped; nil when none is left (Pi's own defaults).
func PiToolFlags(tools []string) []string {
	var ok []string
	for _, t := range tools {
		if piToolNameR.MatchString(t) {
			ok = append(ok, t)
		}
	}
	if len(ok) == 0 {
		return nil
	}
	return []string{"--tools", strings.Join(ok, ",")}
}

// UnattendedFlags are flags for a run nobody is at (a scheduled job, a workflow step in a terminal): for Pi, --no-approve is added (the repository's own Pi files are not trusted, and Pi asks nobody) and
// an --approve or -a is dropped; the session is kept. Other CLIs' flags are returned as they are. A copy: the caller's slice is never changed.
func UnattendedFlags(agentType string, flags []string) []string {
	if agentType != at.Pi {
		return flags
	}
	out := make([]string, 0, len(flags)+1)
	for _, f := range flags {
		if dropsTrustOrSession(f) || f == "--no-approve" {
			continue // the trust and resume flags in every form go; --no-approve is put back last, once
		}
		out = append(out, f)
	}
	return append(out, "--no-approve")
}
