package routes

import (
	"log/slog"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// A best-effort safety net, not a guarantee (#3182; operator, 2026-10-13): the
// high-risk actions it recognises wait for the user, with an auto_accept_skipped
// event saying why. It is not a full shell parser, so risky actions can still be
// approved, and the user is told so when turning auto-accept on. The list
// applies to every auto-accept, local or from the Cloud Hub:
//
//   - recursive rm (-r, -R, -rf, --recursive) of anything outside the session's
//     working directory, or of a target that cannot be read literally
//     ($VAR, ~, $(…), globs at the root)
//   - git push --force / -f / --force-with-lease / a +refspec
//   - git reset --hard, git clean (not a dry run), git checkout -- …/./-f and
//     git restore (except --staged only): they destroy uncommitted work
//   - git push --mirror (it overwrites the remote's refs, like a force push)
//   - git push --delete / -d / :branch (deletes a remote branch)
//   - su, and perl -i on a file outside the working directory
//   - sudo / doas (backslash escapes inside a word are undone: s\udo is sudo), also as \sudo, (sudo …), $(sudo …), `sudo …`, /usr/bin/sudo
//   - find … -delete / -exec rm … with a search path outside the working
//     directory, and sed -i on a file outside it
//   - any of the above after a cd out of the working directory in the same
//     command (cd .., cd /tmp, cd ~, cd $X): later paths count from there
//   - chmod -R / chown -R of anything outside the working directory
//   - curl or wget piped into a shell (curl … | sh, bash <(curl …))
//   - a shell write outside the working directory: a > or >> redirection
//     target, tee's files, the destination of cp, install or ln, any path of
//     mv (its sources go away too), dd of= (/dev/null, /dev/stdout,
//     /dev/stderr and /dev/tty are fine)
//   - a file read or write by a tool (Write, Edit, MultiEdit, NotebookEdit,
//     Read, Codex edits) outside the working directory
//
// The command and path come from the PreToolUse hook's tool input when there
// is one, otherwise from the prompt on screen. Paths have symlinks resolved;
// one that cannot be read literally ($VAR, ~, $(…)) counts as outside. The
// patterns are read without a full shell parser, so they err on the side of
// asking: a ">" inside a quoted string can hold a prompt for the user. Other
// shell commands that write elsewhere (touch, mkdir, a script) are not
// inspected for paths.

var (
	shellSplitRe   = regexp.MustCompile(`&&|\|\||[;|\n]`)
	curlPipeRe     = regexp.MustCompile(`\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b`)
	curlSubstRe    = regexp.MustCompile(`\b(ba|z|da|k)?sh\s+<\(\s*(curl|wget)\b`)
	envAssignRe    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	shellWrapperRe = regexp.MustCompile(`(?i)^(.*[/\\])?(ba|z|da|k)?sh(\.exe)?$`)
)

// Tools whose path input is read or written.
var autoAcceptFileTools = map[string]string{
	"Write":                "writes",
	"Edit":                 "writes",
	"MultiEdit":            "writes",
	"NotebookEdit":         "writes",
	"Update":               "writes", // Claude's screen name for Edit
	"Read":                 "reads",
	"write_to_file":        "writes",
	"replace_file_content": "writes",
	"view_file":            "reads",
}

// shellRisk returns why a shell command is high-risk, or "". On Windows the words are split as a POSIX shell's, where
// a backslash escapes the next character, so PowerShell's `rm -rf ..\..` would read as the file "...." and `\Windows` as
// the relative "Windows": the command is judged a second time with every backslash turned into "/", and the first risk
// found is the answer (a path with backslashes is then the path it names).
func shellRisk(command, workDir string) string {
	return shellRiskWithin(command, workDir)
}

// shellRiskDeadline bounds one judgement of a command (a variable for the tests). The step budget inside each scanner is the real fix for a loop; this is the belt: past it the answer is "ask" and a warning
// is logged, so a leak shows. Go cannot stop a goroutine, so a spinning one would still burn a core until the process ends: the log line is how it would be seen (#7201).
var shellRiskDeadline = 10 * time.Second

// shellRiskImpl is the judgement the deadline wraps (a variable so a test can make it spin).
var shellRiskImpl = shellRiskUnbounded

const whyTookTooLong = "it took too long to check"

func shellRiskWithin(command, workDir string) string {
	done := make(chan string, 1)
	impl := shellRiskImpl // read here, by the caller: the goroutine below may outlive a test that swaps the variable
	go func() {
		// safego.Recover is the census's first statement (a bare go statement fails TestEveryGoroutineRecovers); the recover below runs first and answers
		// the caller, so this one only catches what that one could not.
		defer safego.Recover("auto-accept shell risk")
		defer func() {
			if r := recover(); r != nil {
				slog.Warn("auto-accept: judging a command panicked; it was left to the person", "bytes", len(command), "panic", r)
				done <- "it could not be checked"
			}
		}()
		done <- impl(command, workDir)
	}()
	timer := time.NewTimer(shellRiskDeadline)
	defer timer.Stop()
	select {
	case why := <-done:
		return why
	case <-timer.C:
		slog.Warn("auto-accept: judging a command did not finish in time; it was left to the person, and its goroutine may still be running", "deadline", shellRiskDeadline.String(), "bytes", len(command))
		return whyTookTooLong
	}
}

func shellRiskUnbounded(command, workDir string) string {
	why := shellRiskFrom(command, workDir, workDir)
	if why != "" || runtime.GOOS != "windows" {
		return why
	}
	// PowerShell's and cmd's own destructive commands (Remove-Item, del /s, rd /s, ...), read as they read them.
	if why := winVerbRisk(command, func(p string) bool { return unreadablePath(p) || !pathInside(p, workDir) }); why != "" {
		return why
	}
	if !strings.Contains(command, `\`) {
		return ""
	}
	return shellRiskFrom(strings.ReplaceAll(command, `\`, "/"), workDir, workDir)
}

// shellRiskFrom is shellRisk for a command that starts in dir (a bash -c after a cd). The rules per command (shellRiskSimple) read the command as a list of simple commands cut at
// ; | && || and newlines, which is not how a shell reads { ...; }, if/then/fi, for/while/until, case, select, function bodies, ( ... ) with spaces, ! and $( ) (#7086): compoundRisk
// reads the command with a real shell parser and judges every simple command inside, so a risky command is found wherever the grammar puts it. The answer is never weaker than
// shellRiskSimple's.
func shellRiskFrom(command, workDir, dir string) string {
	return newRiskRun().from(command, workDir, dir)
}

// shellRiskSimple is the rule per command over the command cut at the shell's separators, and the command inside a shell wrapper read the same way: what shellRiskFrom was before
// #7086, kept as the floor the compound reading is never below (and as the function #4599's equivalence test compares).
func shellRiskSimple(command, workDir, dir string) string {
	return shellRiskCoreMode(command, workDir, dir, shellRiskSimple, false)
}

// shellRiskCore is the rules per command, with the rules for the commands that run other commands (#7106); inner judges the command inside a bash -c '...'.
func shellRiskCore(command, workDir, dir string, inner func(command, workDir, dir string) string) string {
	return shellRiskCoreMode(command, workDir, dir, inner, true)
}

// shellRiskCoreMode is shellRiskCore; launch false leaves out what #7106 added (eval, trap, xargs, find -exec, aliases, a shell reading its input, source <( ), the writes of curl, wget, mkfifo,
// shred and truncate, a leading !), which is the reading shellRiskSimple keeps as the floor the #4599 equivalence test compares.
func shellRiskCoreMode(command, workDir, dir string, inner func(command, workDir, dir string) string, launch bool) string {
	if curlPipeRe.MatchString(command) || curlSubstRe.MatchString(command) {
		return "it pipes a download into a shell"
	}
	// The directory later commands run in: a cd out of the working directory moves it
	// ("" = somewhere that cannot be read literally, e.g. cd ~ or cd $X).
	cwd := dir
	at := func(args []string) []string { return fromDir(args, cwd) }
	aliases := map[string]string{} // aliases the command defines, name to command (#7106)
	// ">|" (overwrite despite noclobber) is a redirection, not a pipe.
	for _, seg := range shellSplitRe.Split(strings.ReplaceAll(command, ">|", "> "), -1) {
		raw := seg // with its redirections: a here-string is read from it
		seg, targets := redirections(seg)
		if p := firstGitHookPath(at(notDevices(targets))); p != "" {
			return gitHookWhy(p) // a redirect into a hook or git's config (#186)
		}
		if o := outsideTarget(at(notDevices(targets)), workDir); o != "" {
			return "it writes outside the working directory (" + o + ")"
		}
		words := shellWords(seg)
		// Skip env assignments and shell wrappers (bash -lc '…' is split by the caller).
		if launch {
			words = dropNegation(unwrapCommand(dropNegation(words)))
			for n, v := range aliasesIn(raw) {
				aliases[n] = v
			}
		} else {
			words = unwrapCommand(words)
		}
		if len(words) == 0 {
			continue
		}
		if why := switchesUser(words); why != "" {
			return why
		}
		cmd := filepath.Base(bareCommand(words[0]))
		args := words[1:]
		if launch {
			if v, ok := aliases[cmd]; ok { // an alias defined earlier in the command runs its text
				if why := inner(v+" "+strings.Join(args, " "), workDir, cwd); why != "" {
					return why
				}
			}
			if why := launchedRisk(cmd, args, raw, workDir, cwd, inner); why != "" {
				return why
			}
		}
		if cmd == "git" || shellWrapperRe.MatchString(words[0]) {
			why, decoded := gitQuotedConfigRisk(seg)
			if why != "" {
				return why
			}
			// Preserve the old conservative check when a wrapper (e.g. env -S)
			// exposed Git to shellWords but not to the quote-aware reading.
			if cmd == "git" && !decoded {
				if why := gitCodeExecRisk(args); why != "" {
					return why
				}
			}
		}
		if why := posixHookWriteRisk(cmd, args, nil, at); why != "" {
			return why
		}
		if cmd == "cd" || cmd == "pushd" {
			cwd = changeDir(cwd, args)
			continue
		}
		if check, ok := shellCommandRisks[cmd]; ok {
			if why := check(cmd, args, at, workDir); why != "" {
				return why
			}
			if launch { // inline code (perl -e) after the command's own rule found nothing
				if why := inlineCodeRisk(cmd, args); why != "" {
					return why
				}
			}
			continue
		}
		if check, ok := launchCommandRisks[cmd]; ok && launch {
			if why := check(cmd, args, at, workDir); why != "" {
				return why
			}
			continue
		}
		// bash -c '…' / zsh -lc '…': inspect the inner command.
		if shellWrapperRe.MatchString(words[0]) {
			ranC := false
			for i, a := range args {
				if strings.HasPrefix(a, "-") && strings.Contains(a, "c") && i+1 < len(args) {
					ranC = true
					if why := inner(strings.Join(args[i+1:], " "), workDir, cwd); why != "" {
						return why
					}
					break
				}
			}
			if !ranC && launch { // a shell reading its commands from its input: a here-string is read, anything else is not in the command (#7106)
				if text, ok := hereString(raw); ok {
					if why := inner(text, workDir, cwd); why != "" {
						return why
					}
				} else if stdinShell(args) {
					return whyInputCommand
				}
			}
		}
	}
	return ""
}

// switchesUser is why a command's words run something as another user: sudo or doas anywhere (also as \sudo,
// (sudo …), $(sudo …), `sudo …`, /usr/bin/sudo), or su as a command ($(su …), (su …), `su …`), not the word "su".
func switchesUser(words []string) string {
	for _, w := range words {
		if b := filepath.Base(bareCommand(w)); b == "sudo" || b == "doas" {
			return "it uses sudo"
		} else if b == "su" && bareCommand(w) != w {
			return "it switches user (su)"
		}
	}
	return ""
}

// unwrapCommand drops what runs the real command on its behalf, so the checks
// see that command: environment assignments (FOO=1 rm …) and the wrappers env,
// nice, nohup, time, timeout, command, exec, stdbuf and ionice, with their
// options. (xargs is not unwrapped: its targets come from input, a documented
// limit.)
func unwrapCommand(words []string) []string {
	for len(words) > 0 {
		w := words[0]
		if envAssignRe.MatchString(w) {
			words = words[1:]
			continue
		}
		var takesArg map[string]bool // options of the wrapper that take a value
		positional := 0              // leading values after the options (timeout's duration)
		isEnv := false
		switch filepath.Base(bareCommand(w)) {
		case "env":
			// -S / --split-string takes no value here: its value IS the command line (env -S
			// "rm -rf /etc"), already split into words, so -S is skipped like a plain flag and the
			// command follows. An attached value is handled in the option loop below.
			takesArg = map[string]bool{"-u": true, "--unset": true, "-C": true, "--chdir": true}
			isEnv = true
		case "nice":
			takesArg = map[string]bool{"-n": true, "--adjustment": true}
		case "nohup", "command", "builtin":
		case "time":
		case "timeout":
			takesArg = map[string]bool{"-s": true, "--signal": true, "-k": true, "--kill-after": true}
			positional = 1
		case "exec":
			takesArg = map[string]bool{"-a": true}
		case "stdbuf":
			takesArg = map[string]bool{"-i": true, "-o": true, "-e": true}
		case "ionice":
			takesArg = map[string]bool{"-c": true, "-n": true, "-p": true}
		default:
			return words
		}
		words = words[1:]
	opts:
		for len(words) > 0 {
			a := words[0]
			switch {
			case isEnv && (strings.HasPrefix(a, "--split-string=") || (strings.HasPrefix(a, "-S") && !strings.HasPrefix(a, "--"))):
				// An attached value (-S'rm -rf /etc', --split-string=rm …) starts the command.
				v := strings.Trim(strings.TrimPrefix(strings.TrimPrefix(a, "--split-string="), "-S"), `'"`)
				if v == "" {
					words = words[1:]
				} else {
					words = append([]string{v}, words[1:]...)
				}
				break opts
			case takesArg[a]:
				words = words[min(2, len(words)):]
			case strings.HasPrefix(a, "-") && a != "-":
				words = words[1:]
			case positional > 0:
				positional--
				words = words[1:]
			default:
				break opts
			}
		}
	}
	return words
}

// bareCommand strips what can hide a command name: a leading backslash (\sudo), a
// subshell or substitution opener ((sudo, $(sudo, `sudo, {), a closing ) or `.
func bareCommand(w string) string {
	for {
		t := strings.TrimLeft(w, `\({`+"`")
		t = strings.TrimPrefix(t, "$(")
		if t == w {
			break
		}
		w = t
	}
	return strings.TrimRight(w, ")`}")
}

// unescapeWord drops shell backslash escapes inside a word (s\udo is sudo, \; is ;).
func unescapeWord(w string) string {
	if !strings.Contains(w, `\`) {
		return w
	}
	var b strings.Builder
	for i := 0; i < len(w); i++ {
		if w[i] == '\\' && i+1 < len(w) {
			i++
		}
		b.WriteByte(w[i])
	}
	return b.String()
}

// shellWords splits a command segment into words, dropping quotes.
func shellWords(seg string) []string {
	var out []string
	for _, f := range strings.Fields(seg) {
		f = unescapeWord(strings.Trim(f, `'"`))
		if f != "" {
			out = append(out, f)
		}
	}
	return out
}

// autoAcceptRisk returns why the action behind an approval prompt is high-risk
// (so it waits for the user), or "". It checks the PreToolUse input and what
// the prompt shows; either one being high-risk is enough.
func autoAcceptRisk(agentType, workDir string, pending *pendingTool, d approvalDecision, capture string) string {
	pendingPath := false // the PreToolUse input names the file: it is the path, the screen only shows it
	if pending != nil {
		if pending.Unjudged != "" { // the request cannot be read whole (longer than Coral keeps, not text, or hiding characters): never auto-accepted (#11399)
			return pending.Unjudged
		}
		// The whole text, not the cut one the chat shows; a pending tool made without it (a test, an older caller) reads its input.
		field := func(k string) (string, bool) {
			if pending.Risk != nil {
				s, ok := pending.Risk[k]
				return s, ok
			}
			s, ok := pending.Input[k].(string)
			return s, ok
		}
		cmd, ok := field("command")
		if !ok {
			cmd, ok = field("CommandLine")
		}
		if ok {
			if why := shellRisk(cmd, workDir); why != "" {
				return why
			}
		}
		for _, k := range []string{"file_path", "notebook_path", "path", "TargetFile", "AbsolutePath"} {
			if p, ok := field(k); ok && strings.TrimSpace(p) != "" {
				pendingPath = true
				if why := fileRisk(pending.ToolName, p, workDir); why != "" {
					return why
				}
			}
		}
	}
	tool, input := screenAction(agentType, d, capture)
	if hidesText(strings.ReplaceAll(input, "\x00", "")) { // what the screen shows holds characters that hide what it does (#11399)
		return "what the prompt shows holds a character that can hide what it does, so it cannot be judged"
	}
	switch tool {
	case "command", "Bash", "run_command":
		// A command wrapped over several screen lines: try it joined both ways.
		for _, c := range []string{input, strings.ReplaceAll(input, "\x00", "")} {
			if why := shellRisk(strings.ReplaceAll(c, "\x00", " "), workDir); why != "" {
				return why
			}
		}
		// A command of several lines (Codex shows each as it was written) is also judged line by line: joined with spaces, "echo ok" then "rm -rf /x" is one echo (#7208).
		if why := shellRisk(strings.ReplaceAll(input, "\x00", "\n"), workDir); why != "" {
			return why
		}
	case "ambiguous":
		return "the prompt shows more than one approval header, so what it asks about is unclear"
	case "edit", "write_to_file", "replace_file_content":
		if why := fileRisk("write_to_file", strings.ReplaceAll(input, "\x00", ""), workDir); why != "" {
			return why
		}
	default:
		// A path the screen wrapped is joined without a space: the terminal breaks a
		// long path mid-word, so a space there would make a different, bogus path
		// (outside the repository, refusing every long in-repo path, #3207 QA). When
		// the PreToolUse input named the path, that is authoritative and was checked.
		if !pendingPath {
			if why := fileRisk(tool, strings.ReplaceAll(input, "\x00", ""), workDir); why != "" {
				return why
			}
		}
	}
	return ""
}
