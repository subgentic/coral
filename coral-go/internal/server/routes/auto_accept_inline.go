package routes

import (
	"regexp"
	"strings"
)

// The last open forms of auto-accept (#7201): a command that runs code it is given inline (python -c, node -e, perl -e, ruby -e, php -r, awk with a command, osascript -e, ...), a command run on
// another computer (ssh, mosh, autossh, sshpass) and one that runs commands for a list (parallel). The rule for the whole family is the Orchestrator's: if a word could put inline code or a remote
// command in front of an interpreter, ask. No option arity is modelled (a value in the next word is read as any other word), so a script's own -c or -e after its name asks too: over-asking is the
// accepted cost. Running a script FILE (python3 x.py, node x.js, perl x.pl) stays as it is, and so do the version and help flags and a module run (python3 -m pytest).

// inlineCodeRisk is why a command that runs inline code, a remote command or a command list is high-risk ("" when it is none of them).
func inlineCodeRisk(cmd string, args []string) string {
	name := interpreterName(cmd)
	if name == "" {
		return ""
	}
	// everything before a lone -- is read; after it the words belong to the program that was named
	if i := indexOf(args, "--"); i >= 0 {
		args = args[:i]
	}
	switch name {
	case "python", "node", "deno", "bun", "perl", "ruby", "php", "osascript", "lua", "Rscript", "julia", "emacs", "vim", "npx", "groovy", "tsnode", "powershell", "expect":
		if inlineCodeFlag(name, args) {
			return "it runs inline code (" + cmd + ")"
		}
	case "npm":
		if indexOf(args, "exec") >= 0 || indexOf(args, "x") >= 0 || indexOf(args, "dlx") >= 0 { // npm exec -c 'command', pnpm dlx, yarn dlx: the runner of npx
			if inlineCodeFlag("npx", args) {
				return "it runs inline code (" + cmd + " exec)"
			}
		}
	case "repl":
		if !onlyInfoFlags(args) {
			return "it reads a program from its input (" + cmd + ")"
		}
	case "sed":
		if sedRunsCommands(args) {
			return "it runs a command or writes a file from a sed script (sed)"
		}
	case "tclsh":
		return "it runs Tcl code (tclsh)"

	case "rsync":
		if rsyncRemoteShell(args) {
			return "it runs a remote shell command (rsync -e)"
		}
	case "awk":
		if awkStartsCommand(args) {
			return "it runs commands from an awk program (" + cmd + ")"
		}
	case "ssh":
		if sshRunsRemotely(args) {
			return "it runs a command on another computer (" + cmd + ")"
		}
	case "parallel":
		if !onlyInfoFlags(args) {
			return "it runs commands for a list (parallel)"
		}
	}
	return ""
}

func indexOf(args []string, w string) int {
	for i, a := range args {
		if a == w {
			return i
		}
	}
	return -1
}

var (
	pythonNameRe = regexp.MustCompile(`^(python|pypy)[0-9.]*$`)
	awkNameRe    = regexp.MustCompile(`^(awk|gawk|mawk|nawk|busybox-awk)$`)
	vimNameRe    = regexp.MustCompile(`^(vim|nvim|vi|view|ex|gvim)$`)
)

// interpreterName is the family of a command name (a .exe is dropped): python3.11 and pypy3 are python, nodejs is node, gawk is awk, nvim is vim, mosh and autossh and sshpass are ssh.
func interpreterName(cmd string) string {
	cmd = strings.TrimSuffix(cmd, ".exe")
	switch {
	case pythonNameRe.MatchString(cmd), cmd == "py":
		return "python"
	case cmd == "node" || cmd == "nodejs":
		return "node"
	case awkNameRe.MatchString(cmd):
		return "awk"
	case vimNameRe.MatchString(cmd):
		return "vim"
	}
	switch cmd {
	case "deno", "bun", "perl", "ruby", "php", "ssh", "parallel", "osascript", "lua", "Rscript", "julia", "emacs", "npx", "tclsh", "rsync", "groovy", "expect", "sed", "npm", "pnpm", "yarn":
		if cmd == "pnpm" || cmd == "yarn" {
			return "npm"
		}
		return cmd
	case "ts-node", "tsx":
		return "tsnode"
	case "pwsh", "powershell":
		return "powershell"
	case "irb", "jshell":
		return "repl"
	case "mosh", "autossh", "sshpass", "mosh-client":
		return "ssh"
	}
	return ""
}

// inlineCodeFlag reports whether the words of an interpreter's command line could give it code to run: a flag anywhere before a lone -- (python: -c or an option group with c, -m timeit; node and bun:
// -e, -p, -pe, --eval, --print; deno: eval, -e, --eval; perl: -e, -E; ruby: -e; php: -r, -R, -B, -E, --run; osascript, lua, Rscript, julia: -e; emacs: --eval, --execute; vim: -c, --cmd, +command; npx: -c).
// A bare interpreter, or "-", reads its program from its input and asks too, unless it only answers a question (--version, -V, -h).
func inlineCodeFlag(name string, args []string) bool {
	hasOperand := false
	for i, a := range args {
		if !strings.HasPrefix(a, "-") && !(name == "vim" && strings.HasPrefix(a, "+")) {
			hasOperand = true
			if name == "deno" && a == "eval" {
				return true
			}
			if name == "python" && i > 0 && args[i-1] == "-m" && (a == "timeit" || a == "code" || a == "pdb" || a == "runpy") {
				return true // a module run that runs the code it is given
			}
			continue
		}
		if name == "vim" && strings.HasPrefix(a, "+") && len(a) > 1 && !isDigits(a[1:]) {
			return true // +command
		}
		if name == "powershell" {
			if powershellGivesCode(a) {
				return true
			}
			continue
		}
		if strings.HasPrefix(a, "--") {
			long := strings.SplitN(a, "=", 2)[0]
			switch name {
			case "node", "bun", "deno", "tsnode":
				if long == "--eval" || long == "--print" {
					return true
				}
			case "php":
				if long == "--run" {
					return true
				}
			case "julia":
				if long == "--eval" || long == "--print" {
					return true
				}
			case "emacs":
				if long == "--eval" || long == "--execute" || long == "--funcall" || long == "--load" {
					return true
				}
			case "vim":
				if long == "--cmd" {
					return true
				}
			case "npx":
				if long == "--call" || long == "--eval" || long == "--print" {
					return true
				}
			case "osascript", "Rscript", "groovy":
				if long == "--eval" || long == "--expression" || long == "--exec" {
					return true
				}
			}
			continue
		}
		// a short option word: its leading run of letters is the option group
		letters := a[1:]
		for k := 0; k < len(letters); k++ {
			if !isLetter(letters[k]) {
				letters = letters[:k]
				break
			}
		}
		if letters == "" {
			continue
		}
		if shortGroupGivesCode(name, letters) {
			return true
		}
	}
	if name == "osascript" || name == "lua" || name == "Rscript" || name == "julia" || name == "emacs" || name == "vim" || name == "npx" || name == "groovy" || name == "tsnode" {
		return false // an editor, a runner or a script file named alone is not a program read from its input here
	}
	return !hasOperand && !onlyInfoFlags(args)
}

// powershellGivesCode reports whether a PowerShell parameter word gives it code: -Command and its abbreviations (-c, -co, ...), -EncodedCommand (-e, -ec, -en, ...), also with / or a value after a colon. -File and the other
// parameters do not (-ExecutionPolicy is not read as -e).
func powershellGivesCode(a string) bool {
	if !strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "/") {
		return false
	}
	w := strings.ToLower(strings.TrimLeft(a, "-/"))
	w = strings.SplitN(w, ":", 2)[0]
	if w == "" {
		return false
	}
	if strings.HasPrefix("command", w) || strings.HasPrefix("encodedcommand", w) {
		return true
	}
	return w == "ec" || w == "e"
}

// sedRunsCommands reports whether a sed script (-e, --expression=, or the first word that is not an option) holds a command that runs another or writes a file: e, w, W, or the e and w flags of s. -f names a
// script file, left as it is.
func sedRunsCommands(args []string) bool {
	var scripts []string
	gotScript := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-f" || a == "--file" || strings.HasPrefix(a, "--file="):
			return false
		case a == "-e" || a == "--expression":
			if i+1 < len(args) {
				scripts = append(scripts, args[i+1])
				gotScript = true
				i++
			}
		case strings.HasPrefix(a, "--expression="):
			scripts = append(scripts, strings.TrimPrefix(a, "--expression="))
			gotScript = true
		case a == "-l" || a == "--line-length":
			i++
		case strings.HasPrefix(a, "-") && len(a) > 1 && !strings.HasPrefix(a, "--"):
			// a group such as -ne, -ni, -i.bak: an e in it is -e whose script is the next word
			letters := a[1:]
			for k := 0; k < len(letters); k++ {
				if !isLetter(letters[k]) {
					break
				}
				if letters[k] == 'e' && i+1 < len(args) {
					scripts = append(scripts, args[i+1])
					gotScript = true
					i++
					break
				}
				if letters[k] == 'i' {
					break
				}
			}
		case strings.HasPrefix(a, "-"):
		default:
			if !gotScript {
				scripts = append(scripts, a)
				gotScript = true
			}
		}
	}
	for _, sc := range scripts {
		if sedScriptRuns(sc) {
			return true
		}
	}
	return false
}

// sedScriptRuns reads a sed script command by command (addresses, s and y with their delimiters, a, i, c text to the end of the line, labels) and reports an e, w or W command, or an e or w flag of s.
// Every pass of the loop consumes at least one character and the whole read has a step budget: a script it cannot read to the end (a trailing backslash, an unterminated address) is answered as
// a command that runs something, never looped on (#7201 round 2: QA's fuzz found a script that never returned).
func sedScriptRuns(sc string) bool {
	i, n := 0, len(sc)
	skipTo := func(delim byte) { // past the next unescaped delim, or to the end
		for i < n {
			if sc[i] == '\\' && i+1 < n {
				i += 2
				continue
			}
			if sc[i] == delim {
				i++
				return
			}
			i++
		}
	}
	// skipRegex is skipTo for a regular expression: a [ opens a bracket expression, inside which the delimiter and the backslash are ordinary characters (/[/]/p matches the lines that hold a slash), a ] first
	// in it (or after ^) is a member, and [:class:], [.x.] and [=x=] are read whole. A bracket that is not closed before the end of the script makes the script unreadable (ok false).
	skipRegex := func(delim byte) (ok bool) {
		for i < n {
			switch c := sc[i]; {
			case c == '\\' && i+1 < n:
				i += 2
			case c == delim:
				i++
				return true
			case c == '[':
				i++
				if i < n && sc[i] == '^' {
					i++
				}
				if i < n && sc[i] == ']' {
					i++
				}
				closed := false
				for i < n {
					if sc[i] == '[' && i+1 < n && strings.IndexByte(":.=", sc[i+1]) >= 0 {
						end := strings.Index(sc[i+2:], string(sc[i+1])+"]")
						if end < 0 {
							return false
						}
						i += 2 + end + 2
						continue
					}
					if sc[i] == ']' {
						i++
						closed = true
						break
					}
					i++
				}
				if !closed {
					return false
				}
			default:
				i++
			}
		}
		return true // the end of the script before the delimiter: nothing more to read
	}
	unreadable := false
	parseAddr := func() bool {
		switch {
		case sc[i] >= '0' && sc[i] <= '9':
			for i < n && sc[i] >= '0' && sc[i] <= '9' {
				i++
			}
		case sc[i] == '$':
			i++
		case sc[i] == '/':
			i++
			if !skipRegex('/') {
				unreadable = true
			}
		case sc[i] == '\\' && i+1 < n:
			d := sc[i+1]
			i += 2
			if !skipRegex(d) {
				unreadable = true
			}
		default:
			return false
		}
		for i < n && (sc[i] == 'I' || sc[i] == 'M') {
			i++
		}
		return true
	}
	budget := 8*n + 64
	for i < n {
		if budget--; budget < 0 {
			return true // cannot be read to the end: ask
		}
		start := i
		for i < n && strings.IndexByte(" \t\n;{}", sc[i]) >= 0 {
			i++
		}
		if i >= n {
			break
		}
		if parseAddr() {
			for i < n && (sc[i] == ',' || sc[i] == '~' || sc[i] == '+') {
				i++
				if i < n {
					parseAddr()
				}
			}
		}
		if unreadable {
			return true // a bracket expression that does not close: cannot be read, ask
		}
		for i < n && (sc[i] == '!' || sc[i] == ' ' || sc[i] == '\t') {
			i++
		}
		if i >= n {
			break
		}
		c := sc[i]
		i++
		switch c {
		case 'e', 'w', 'W':
			return true
		case 's', 'y':
			if i >= n {
				return false
			}
			d := sc[i]
			i++
			if c == 's' {
				if !skipRegex(d) {
					return true
				}
			} else {
				skipTo(d)
			}
			skipTo(d)
			if c == 's' {
				for i < n && strings.IndexByte(";\n} \t", sc[i]) < 0 {
					if sc[i] == 'e' || sc[i] == 'w' {
						return true
					}
					i++
				}
			}
		case 'a', 'i', 'c':
			for i < n && sc[i] != '\n' {
				i++
			}
		case ':', 'b', 't', 'T', 'r', 'R', 'l', 'L', 'q', 'Q':
			for i < n && sc[i] != ';' && sc[i] != '\n' {
				i++
			}
		}
		if i == start {
			i++
		}
	}
	return false
}

// shortGroupGivesCode reports whether a group of short option letters holds one that gives the interpreter code. For perl the letters after a letter that takes the rest of its word as a value are
// not options (-MFile::Path, -I/lib), so the group is read up to it.
func shortGroupGivesCode(name, letters string) bool {
	valued := ""
	if name == "perl" {
		valued = "IMmFiCdDV"
	}
	for k := 0; k < len(letters); k++ {
		c := letters[k]
		switch name {
		case "python":
			if c == 'c' {
				return true
			}
		case "node", "bun", "deno", "tsnode":
			if c == 'e' || c == 'p' {
				return true
			}
		case "groovy":
			if c == 'e' {
				return true
			}
		case "expect":
			if c == 'c' {
				return true
			}
		case "perl":
			if c == 'e' || c == 'E' {
				return true
			}
		case "ruby", "osascript", "lua", "Rscript", "julia":
			if c == 'e' || (name == "julia" && (c == 'E' || c == 'p')) {
				return true
			}
		case "php":
			if c == 'r' || c == 'R' || c == 'B' || c == 'E' {
				return true
			}
		case "vim":
			if c == 'c' || c == 'S' {
				return true
			}
		case "npx":
			if c == 'c' || c == 'e' || c == 'p' {
				return true
			}
		case "emacs":
			if c == 'f' {
				return true
			}
		}
		if strings.IndexByte(valued, c) >= 0 {
			break
		}
	}
	return false
}

func isLetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func isDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return s != ""
}

// onlyInfoFlags reports whether every argument is a version or help request (or there is none to a command that needs some): --version, -V, -v, -h, --help, -?.
func onlyInfoFlags(args []string) bool {
	if len(args) == 0 {
		return false
	}
	for _, a := range args {
		switch a {
		case "--version", "-V", "-v", "--help", "-h", "-?", "-version", "--info", "-i":
		default:
			return false
		}
	}
	return true
}

var awkSystemRe = regexp.MustCompile(`\bsystem\s*\(`)

// awkStartsCommand reports whether an awk command line could start a command: system(), or any | that is not the or operator || (print | "sort", c | getline, |&). The field separator (-F|, -F '|')
// and -v assignments are not read, so awk -F'|' '{print $1}' f is left alone; -f names a program file, left as it is.
func awkStartsCommand(args []string) bool {
	var text []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-f" || a == "--file" || strings.HasPrefix(a, "-f") && !strings.HasPrefix(a, "-field"):
			return false
		case a == "-F" || a == "-v" || a == "--assign" || a == "--field-separator":
			i++
		case strings.HasPrefix(a, "-F") || strings.HasPrefix(a, "-v") || strings.HasPrefix(a, "--field-separator=") || strings.HasPrefix(a, "--assign="):
		case strings.HasPrefix(a, "--source="):
			text = append(text, strings.TrimPrefix(a, "--source="))
		case strings.HasPrefix(a, "-e") && len(a) > 2:
			text = append(text, a[2:])
		case strings.HasPrefix(a, "-"):
		default:
			text = append(text, a)
		}
	}
	prog := strings.Join(text, " ")
	if awkSystemRe.MatchString(prog) {
		return true
	}
	for i := 0; i < len(prog); i++ {
		if prog[i] == '|' {
			if i+1 < len(prog) && prog[i+1] == '|' {
				i++ // the or operator
				continue
			}
			return true
		}
	}
	return false
}

// rsyncRemoteShell reports whether rsync is given a remote shell command: -e or --rsh, alone, attached or in a group (-avze ssh).
func rsyncRemoteShell(args []string) bool {
	for _, a := range args {
		if strings.HasPrefix(a, "--rsh") {
			return true
		}
		if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") {
			letters := a[1:]
			for k := 0; k < len(letters); k++ {
				if !isLetter(letters[k]) {
					break
				}
				if letters[k] == 'e' {
					return true
				}
			}
		}
	}
	return false
}

// sshRunsRemotely reports whether an ssh-like command opens a session or runs a command on another computer: anything but its version and its configuration queries (-V, -G, -Q).
func sshRunsRemotely(args []string) bool {
	for _, a := range args {
		if a == "-V" || a == "-G" || strings.HasPrefix(a, "-Q") {
			return false
		}
	}
	return true
}

// awkInplaceRisk judges gawk -i inplace: the files after the program are rewritten where they are, so one outside the working folder is a write there.
func awkInplaceRisk(_ string, args []string, at func([]string) []string, workDir string) string {
	inplace, gotProg := false, false
	var files []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case (a == "-i" || a == "--include") && i+1 < len(args):
			if args[i+1] == "inplace" {
				inplace = true
			}
			i++
		case a == "-iinplace" || a == "--include=inplace":
			inplace = true
		case a == "-f" || a == "--file" || a == "-e" || a == "--source":
			gotProg = true
			i++
		case a == "-F" || a == "-v" || a == "--assign" || a == "--field-separator":
			i++
		case strings.HasPrefix(a, "-f") || strings.HasPrefix(a, "--source=") || strings.HasPrefix(a, "--file=") || strings.HasPrefix(a, "-e"):
			gotProg = true
		case strings.HasPrefix(a, "-"):
		default:
			if !gotProg {
				gotProg = true
			} else {
				files = append(files, a)
			}
		}
	}
	if inplace {
		if t := outsideTarget(at(files), workDir); t != "" {
			return "it rewrites a file outside the working directory (" + t + ")"
		}
	}
	return ""
}
